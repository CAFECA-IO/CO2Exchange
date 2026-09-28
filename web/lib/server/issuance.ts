import "server-only";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { ledgerIssue } from "./ledger/registry";

export type IssuanceRequest = {
  id: string; createdAt: string; updatedAt: string;
  projectId: number; projectName: string; owner: Address; submittedBy: string;
  monitoringStart: string; monitoringEnd: string; amountKg: number; // ISO 日期
  reportFile: string; reportHash: Hex; reportName: string; note?: string;
  status: "pending" | "issued" | "rejected"; reason?: string; batchId?: number; txHash?: Hex; serialHash?: Hex; decidedBy?: string;
};

/// 查驗機構簽一筆 issue 事件，額度記在帳本裡。
///
/// Phase 0：查驗機構的簽章金鑰放在本站（CARBON_VERIFIER_PK）。
/// 正式環境：查驗機構在自己的系統簽事件，本站只收簽章。
export async function signAndIssue(r: IssuanceRequest) {
  const start = BigInt(Math.floor(Date.parse(r.monitoringStart + "T00:00:00Z") / 1000));
  const end = BigInt(Math.floor(Date.parse(r.monitoringEnd + "T23:59:59Z") / 1000));
  // 序號：TW-<projectId>-<start>-<end>-<amount> 的雜湊；正式由登錄簿序號規則產生
  const serial = `TW-P${r.projectId}-${r.monitoringStart}-${r.monitoringEnd}-${r.amountKg}`;
  const serialHash = keccak256(toBytes(serial));
  const attestationId = BigInt(keccak256(toBytes(r.id))) >> 8n;
  const out = await ledgerIssue({ projectId: BigInt(r.projectId), monitoringStart: start, monitoringEnd: end, amountKg: BigInt(r.amountKg), serialHash, reportHash: r.reportHash, attestationId });
  return { ...out, serialHash, serial };
}
