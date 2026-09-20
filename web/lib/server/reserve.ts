import "server-only";
import { parseAbiItem } from "viem";
import { erc20Abi, registryAbi, reserveAbi } from "@/lib/abis";
import { countryCode } from "@/lib/deployment";
import { deployment, publicClient } from "./chain";

/// 託管與準備金揭露。
///
/// 兩件事要對得起來：
///   1. 各國官方登錄簿託管帳戶裡的額度 vs 本站鏈上該轄區的流通量
///   2. 信託專戶裡的錢 vs 鏈上結算幣的發行量
///
/// 「鏈上流通量」這一欄本頁自己算（核發 − 註銷，依轄區分組），不採用報告裡填的數字——
/// 填報的那一欄只代表營運方當時的說法，兩邊放在一起才看得出有沒有出入。

const ISSUED = parseAbiItem(
  "event BatchIssued(uint256 indexed batchId, uint256 indexed projectId, address indexed to, uint256 amountKg, bytes32 serialHash)",
);
const RETIRED = parseAbiItem(
  "event CreditRetired(uint256 indexed batchId, address indexed holder, address indexed certificateOwner, uint256 amountKg, uint256 certId)",
);

export const STATUS_LABEL = ["待查核", "已查核相符", "已查核有差異"] as const;

export type CreditReserveRow = {
  country: string;
  custodian: string;
  accountRef: string;
  heldKg: number;
  /// 報告填報的鏈上量
  reportedOnchainKg: number;
  /// 本頁依鏈上事件即時算出的流通量
  liveOnchainKg: number;
  statementHash: string;
};

export type ReserveReport = {
  reportId: number;
  period: number;
  asOf: number;
  publishedAt: number;
  attestedAt: number;
  status: number;
  auditorName: string;
  note: string;
  documentHash: string;
  credits: CreditReserveRow[];
  cash: { trustee: string; accountRef: string; balance: string; tokenSupply: string; statementHash: string };
};

export type Custody = {
  /// 最新一期報告；從未發布過就是 null
  latest: ReserveReport | null;
  periods: number[];
  /// 即時的鏈上流通量（依轄區），與報告無關
  live: { country: string; name: string; scheme: string; registryName: string; circulatingKg: number }[];
  liveTokenSupply: string;
  /// 下一次揭露日（每月 5 日）
  nextDisclosure: string;
};

/// 依轄區彙總鏈上流通量：核發 − 註銷。
export async function liveByCountry() {
  const d = deployment();
  const [issued, retired] = await Promise.all([
    publicClient.getLogs({ address: d.carbonCredit1155, event: ISSUED, fromBlock: 0n }),
    publicClient.getLogs({ address: d.carbonCredit1155, event: RETIRED, fromBlock: 0n }),
  ]);

  // batchId → projectId（核發事件就帶著，不必再讀合約）
  const batchProject = new Map<number, number>();
  for (const l of issued) batchProject.set(Number(l.args.batchId), Number(l.args.projectId));

  const projectIds = [...new Set([...batchProject.values()])];
  const projects = await Promise.all(
    projectIds.map((pid) =>
      publicClient
        .readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "projectOf", args: [BigInt(pid)] })
        .then((p) => [pid, countryCode(p.country)] as const),
    ),
  );
  const countryOfProject = new Map(projects);

  const kg = new Map<string, number>();
  const add = (c: string, v: number) => kg.set(c, (kg.get(c) ?? 0) + v);
  for (const l of issued) {
    const c = countryOfProject.get(Number(l.args.projectId));
    if (c) add(c, Number(l.args.amountKg));
  }
  for (const l of retired) {
    const pid = batchProject.get(Number(l.args.batchId));
    const c = pid == null ? undefined : countryOfProject.get(pid);
    if (c) add(c, -Number(l.args.amountKg));
  }
  return kg;
}

/// 每月 5 日。今天已過 5 號就給下個月。
export function nextDisclosureDate(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 5));
  if (now.getUTCDate() > 5) d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

export async function custody(): Promise<Custody> {
  const d = deployment();
  const live = await liveByCountry();

  const [codes, supply] = await Promise.all([
    publicClient.readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "countries" }),
    publicClient.readContract({ address: d.settlementToken, abi: erc20Abi, functionName: "totalSupply" }).catch(() => 0n),
  ]);
  const jurisdictions = await Promise.all(
    codes.map((c) =>
      publicClient
        .readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "jurisdictionOf", args: [c] })
        .then((j) => ({ country: countryCode(c), name: j.name, scheme: j.scheme, registryName: j.registryName })),
    ),
  );

  let latest: ReserveReport | null = null;
  let periods: number[] = [];
  if (d.reserveAttestation) {
    const [id, ps] = await Promise.all([
      publicClient.readContract({ address: d.reserveAttestation, abi: reserveAbi, functionName: "latestReportId" }),
      publicClient.readContract({ address: d.reserveAttestation, abi: reserveAbi, functionName: "periods" }),
    ]);
    periods = ps.map(Number);
    if (Number(id) > 0) {
      const [report, credits, cash] = await publicClient.readContract({
        address: d.reserveAttestation, abi: reserveAbi, functionName: "reportOf", args: [id],
      });
      latest = {
        reportId: Number(id),
        period: report.period,
        asOf: Number(report.asOf),
        publishedAt: Number(report.publishedAt),
        attestedAt: Number(report.attestedAt),
        status: report.status,
        auditorName: report.auditorName,
        note: report.note,
        documentHash: report.documentHash,
        credits: credits.map((c) => ({
          country: countryCode(c.country),
          custodian: c.custodian,
          accountRef: c.accountRef,
          heldKg: Number(c.heldKg),
          reportedOnchainKg: Number(c.onchainKg),
          liveOnchainKg: live.get(countryCode(c.country)) ?? 0,
          statementHash: c.statementHash,
        })),
        cash: {
          trustee: cash.trustee,
          accountRef: cash.accountRef,
          balance: cash.balance.toString(),
          tokenSupply: cash.tokenSupply.toString(),
          statementHash: cash.statementHash,
        },
      };
    }
  }

  return {
    latest,
    periods,
    live: jurisdictions
      .map((j) => ({ ...j, circulatingKg: live.get(j.country) ?? 0 }))
      .filter((j) => j.circulatingKg > 0 || j.country === "TW"),
    liveTokenSupply: supply.toString(),
    nextDisclosure: nextDisclosureDate(),
  };
}
