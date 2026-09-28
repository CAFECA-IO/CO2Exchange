import "server-only";
import { erc20Abi } from "viem";
import { deployment, publicClient } from "./chain";
import { ledgerCustody } from "./ledger/read";

/// 託管與準備金揭露。
///
/// 兩件事要對得起來：
///   1. 各國官方登錄簿託管帳戶裡的額度 vs 本站帳本上該轄區的流通量
///   2. 信託專戶裡的錢 vs 鏈上記帳 TWD 的發行量（營運 Safe 確認入金時鑄、確認出金時銷毀）
///
/// 「帳本流通量」這一欄本頁自己算（核發 − 註銷，依轄區分組），不採用報告裡填的數字——
/// 填報的那一欄只代表營運方當時的說法，兩邊放在一起才看得出有沒有出入。
/// 報告本身是帳本裡查核者簽的對帳事件（lib/server/ledger/read.ts 的 ledgerCustody）。

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

/// 每月 5 日。今天已過 5 號就給下個月。
export function nextDisclosureDate(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 5));
  if (now.getUTCDate() > 5) d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

export async function custody(): Promise<Custody> {
  const d = deployment();
  const supply = await publicClient.readContract({ address: d.settlementToken, abi: erc20Abi, functionName: "totalSupply" }).catch(() => 0n);
  return ledgerCustody(supply);
}
