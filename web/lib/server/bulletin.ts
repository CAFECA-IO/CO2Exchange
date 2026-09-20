import "server-only";
import { parseAbiItem, type Address } from "viem";
import { deployment, publicClient } from "./chain";
import { registryAbi } from "@/lib/abis";
import { countryCode } from "@/lib/deployment";
import { tcerSerial } from "../tcer";

/// 公告欄。
///
/// 環境部「溫室氣體減量額度管理系統」（TCER Registry）的公開資訊分五塊：
/// 額度總覽、核發資訊、使用及註銷、移轉紀錄、參與事業。本站照同一個分法，
/// 差別在於資料不是人工上傳，而是**直接從鏈上事件推導**——公告與事實同一份紀錄，
/// 沒有「公告漏貼」或「公告與帳本不符」的可能。
///
/// 依交易拍賣及移轉管理辦法第 27 條，主管機關於註銷次日起五個工作日內公開，
/// 公開後事業始得對外做環境聲明。所以註銷公告會算出「可對外宣告日」。

const ISSUED = parseAbiItem(
  "event BatchIssued(uint256 indexed batchId, uint256 indexed projectId, address indexed to, uint256 amountKg, bytes32 serialHash)",
);
const LISTED = parseAbiItem(
  "event Listed(uint256 indexed orderId, address indexed seller, uint256 indexed batchId, uint256 amountKg, uint256 pricePerTonne, uint256 minFillKg)",
);
const FILLED = parseAbiItem(
  "event Filled(uint256 indexed orderId, address indexed buyer, uint256 amountKg, uint256 cost, uint256 fee)",
);
const RETIRED = parseAbiItem(
  "event CreditRetired(uint256 indexed batchId, address indexed holder, address indexed certificateOwner, uint256 amountKg, uint256 certId)",
);

export type AnnouncementKind = "issue" | "list" | "transfer" | "retire";

export type Announcement = {
  no: string; // 公告編號
  kind: AnnouncementKind;
  ts: number; // 公告時間（= 上鏈時間）
  batchId?: number;
  projectId?: number;
  orderId?: number;
  certId?: number;
  amountKg: number;
  /// 移轉類：買賣雙方；核發類：受配者；註銷類：註銷人與受益人帳戶
  from?: Address;
  to?: Address;
  costTwd?: number; // 最小單位
  pricePerTonne?: number;
  serial?: string; // TCER 格式額度編碼
  txHash: string;
  blockNumber: number;
  /// 核發國（ISO 3166-1 alpha-2）。公告不標國別，讀者就分不出這筆額度在臺灣能不能用。
  country?: string;
  /// 註銷專用：公開日 + 5 個工作日，之後才可以對外宣告（第 27 條）
  claimableFrom?: number;
};

export type BulletinSummary = {
  issuedKg: number;
  retiredKg: number;
  transferredKg: number;
  circulatingKg: number;
  projects: number;
  participants: number;
  lastAnnouncedAt: number | null;
};

export type Bulletin = {
  summary: BulletinSummary;
  announcements: Announcement[];
  participants: { address: Address; issued: number; bought: number; sold: number; retired: number }[];
};

/// 五個工作日：只跳過週六日。國定假日需接行政院行事曆，Phase 0 不做，
/// 所以這個日期是「不早於」的下限，介面要照這樣講。
export function addWorkingDays(from: number, days: number): number {
  const d = new Date(from * 1000);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return Math.floor(d.getTime() / 1000);
}

function no(kind: AnnouncementKind, ts: number, seq: number): string {
  const prefix = { issue: "ISS", list: "LST", transfer: "TRF", retire: "RET" }[kind];
  const y = new Date(ts * 1000).getUTCFullYear();
  return `${prefix}-${y}-${String(seq).padStart(6, "0")}`;
}

async function blockTimes(blocks: bigint[]): Promise<Map<bigint, number>> {
  const uniq = [...new Set(blocks)];
  const out = new Map<bigint, number>();
  await Promise.all(
    uniq.map(async (bn) => {
      const b = await publicClient.getBlock({ blockNumber: bn });
      out.set(bn, Number(b.timestamp));
    }),
  );
  return out;
}

export async function bulletin(): Promise<Bulletin> {
  const d = deployment();
  const [issued, listed, filled, retired] = await Promise.all([
    publicClient.getLogs({ address: d.carbonCredit1155, event: ISSUED, fromBlock: 0n }),
    publicClient.getLogs({ address: d.listing, event: LISTED, fromBlock: 0n }),
    publicClient.getLogs({ address: d.listing, event: FILLED, fromBlock: 0n }),
    publicClient.getLogs({ address: d.carbonCredit1155, event: RETIRED, fromBlock: 0n }),
  ]);

  const times = await blockTimes([...issued, ...listed, ...filled, ...retired].map((l) => l.blockNumber!));
  const at = (bn: bigint) => times.get(bn) ?? 0;

  // 成交要知道賣方是誰，才講得出「從誰移轉到誰」。掛單事件帶得出這層對應。
  const orderSeller = new Map<number, Address>();
  const orderBatch = new Map<number, number>();
  for (const l of listed) {
    orderSeller.set(Number(l.args.orderId), l.args.seller as Address);
    orderBatch.set(Number(l.args.orderId), Number(l.args.batchId));
  }

  // batchId → country：公告每一列都要標核發國
  const batchProject = new Map<number, number>();
  for (const l of issued) batchProject.set(Number(l.args.batchId), Number(l.args.projectId));
  const countryOfProject = new Map(
    await Promise.all(
      [...new Set(batchProject.values())].map((pid) =>
        publicClient
          .readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "projectOf", args: [BigInt(pid)] })
          .then((p) => [pid, countryCode(p.country)] as const),
      ),
    ),
  );
  const countryOfBatch = (batchId?: number) => {
    if (batchId == null) return undefined;
    const pid = batchProject.get(batchId);
    return pid == null ? undefined : countryOfProject.get(pid);
  };

  const rows: Announcement[] = [];
  const seq = { issue: 0, list: 0, transfer: 0, retire: 0 };
  const push = (a: Omit<Announcement, "no">) => {
    seq[a.kind] += 1;
    rows.push({ ...a, country: a.country ?? countryOfBatch(a.batchId), no: no(a.kind, a.ts, seq[a.kind]) });
  };

  for (const l of issued) {
    const batchId = Number(l.args.batchId);
    const projectId = Number(l.args.projectId);
    const ts = at(l.blockNumber!);
    push({
      kind: "issue", ts, batchId, projectId,
      amountKg: Number(l.args.amountKg),
      to: l.args.to as Address,
      serial: tcerSerial({ projectId, batchId, monitoringEnd: ts, amountKg: Number(l.args.amountKg) }),
      txHash: l.transactionHash!, blockNumber: Number(l.blockNumber),
    });
  }
  for (const l of listed) {
    push({
      kind: "list", ts: at(l.blockNumber!),
      orderId: Number(l.args.orderId), batchId: Number(l.args.batchId),
      amountKg: Number(l.args.amountKg),
      from: l.args.seller as Address,
      pricePerTonne: Number(l.args.pricePerTonne),
      txHash: l.transactionHash!, blockNumber: Number(l.blockNumber),
    });
  }
  for (const l of filled) {
    const orderId = Number(l.args.orderId);
    push({
      kind: "transfer", ts: at(l.blockNumber!),
      orderId, batchId: orderBatch.get(orderId),
      amountKg: Number(l.args.amountKg),
      from: orderSeller.get(orderId), to: l.args.buyer as Address,
      costTwd: Number(l.args.cost),
      pricePerTonne: Number(l.args.amountKg) > 0 ? (Number(l.args.cost) * 1000) / Number(l.args.amountKg) : undefined,
      txHash: l.transactionHash!, blockNumber: Number(l.blockNumber),
    });
  }
  for (const l of retired) {
    const ts = at(l.blockNumber!);
    push({
      kind: "retire", ts,
      batchId: Number(l.args.batchId), certId: Number(l.args.certId),
      amountKg: Number(l.args.amountKg),
      from: l.args.holder as Address, to: l.args.certificateOwner as Address,
      claimableFrom: addWorkingDays(ts, 5),
      txHash: l.transactionHash!, blockNumber: Number(l.blockNumber),
    });
  }

  rows.sort((a, b) => b.ts - a.ts || b.blockNumber - a.blockNumber);

  const issuedKg = issued.reduce((s, l) => s + Number(l.args.amountKg), 0);
  const retiredKg = retired.reduce((s, l) => s + Number(l.args.amountKg), 0);
  const transferredKg = filled.reduce((s, l) => s + Number(l.args.amountKg), 0);

  const p = new Map<string, { address: Address; issued: number; bought: number; sold: number; retired: number }>();
  const touch = (a?: Address) => {
    if (!a) return undefined;
    const k = a.toLowerCase();
    if (!p.has(k)) p.set(k, { address: a, issued: 0, bought: 0, sold: 0, retired: 0 });
    return p.get(k)!;
  };
  for (const l of issued) { const r = touch(l.args.to as Address); if (r) r.issued += Number(l.args.amountKg); }
  for (const l of filled) {
    const r = touch(l.args.buyer as Address); if (r) r.bought += Number(l.args.amountKg);
    const s = touch(orderSeller.get(Number(l.args.orderId))); if (s) s.sold += Number(l.args.amountKg);
  }
  for (const l of retired) { const r = touch(l.args.holder as Address); if (r) r.retired += Number(l.args.amountKg); }

  return {
    summary: {
      issuedKg, retiredKg, transferredKg,
      circulatingKg: issuedKg - retiredKg,
      projects: new Set(issued.map((l) => Number(l.args.projectId))).size,
      participants: p.size,
      lastAnnouncedAt: rows[0]?.ts ?? null,
    },
    announcements: rows,
    participants: [...p.values()].sort((a, b) => b.issued + b.bought - (a.issued + a.bought)),
  };
}
