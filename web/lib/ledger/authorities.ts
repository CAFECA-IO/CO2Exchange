import type { Address } from "viem";
import type { Event } from "./events.ts";

/// 授權金鑰清單：誰在哪一段區塊區間內擁有哪一個角色。
///
/// **這份清單的真相在鏈上**（帳本合約的授權登錄，由國家 Safe 管理）。它是整個帳本的信任根：
/// 如果清單也在帳本裡，營運方就能在帳本裡自己加一個假的查驗機構，而重播照樣自洽。
/// 這裡只是把鏈上的歷史讀成一個方便查詢的形狀；引擎與重播從參數收到它，不自己去讀鏈。

export const ROLES = [
  "SOVEREIGN",          // 國家 Safe：轄區、政策、凍結、國外專案、專案狀態
  "OPERATOR",           // 營運方：費率、官方註銷回填、退回出金請求
  "IDENTITY_VERIFIER",  // 身分驗證服務
  "CARBON_VERIFIER",    // 查驗機構
  "DOCUMENT_SIGNER",    // 憑證文件雜湊、對帳報告
  "AUDITOR",            // 查核機構：對帳報告簽署
  "RECEIPT_SIGNER",     // 收單金鑰：簽收收據（不簽事件，但使用者要能確認收據是誰簽的）
] as const;
export type Role = (typeof ROLES)[number];

/// 一段授權：從 `from` 區塊起生效，到 `until` 區塊（不含）失效；`until` 為 null 代表仍有效。
export type Grant = { role: Role; account: Address; from: bigint; until: bigint | null };

/// 角色門檻（k-of-n）的歷史：從 `from` 區塊起，這個角色的授權事件要有 `value` 個不同的有效簽章。
export type Threshold = { role: Role; value: number; from: bigint };

export type Authorities = { grants: Grant[]; thresholds?: Threshold[] };

/// 某個角色在某一塊的門檻。沒設過＝ 1。
export function thresholdAt(a: Authorities, role: Role, atBlock: bigint): number {
  let v = 1;
  let best = -1n;
  for (const t of a.thresholds ?? []) {
    if (t.role !== role || t.from > atBlock) continue;
    if (t.from >= best) { best = t.from; v = t.value; }
  }
  return Math.max(1, v);
}

/// 某個角色在某一塊有效的金鑰（治理頁與提案工具用）。
export const activeKeys = (a: Authorities, role: Role, atBlock: bigint): Address[] =>
  a.grants.filter((g) => g.role === role && g.from <= atBlock && (g.until === null || atBlock < g.until)).map((g) => g.account);

export function isAuthorized(a: Authorities, role: Role, account: Address, atBlock: bigint): boolean {
  const who = account.toLowerCase();
  return a.grants.some((g) => g.role === role && g.account.toLowerCase() === who && g.from <= atBlock && (g.until === null || atBlock < g.until));
}

/// 每一種授權事件需要哪一個角色。使用者事件與鏈上鏡像事件回 null。
export function roleFor(e: Event): Role | null {
  switch (e.kind) {
    case "jurisdiction": case "policy": case "freeze": case "importProject": case "projectStatus":
      return "SOVEREIGN";
    case "fees": case "certOfficial": case "withdrawReject":
      return "OPERATOR";
    case "identity":
      return "IDENTITY_VERIFIER";
    case "issue":
      return "CARBON_VERIFIER";
    case "certDocument": case "reserveReport":
      return "DOCUMENT_SIGNER";
    case "reserveAttest":
      return "AUDITOR";
    default:
      return null;
  }
}
