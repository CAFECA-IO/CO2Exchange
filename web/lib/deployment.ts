import type { Address } from "viem";

export type Deployment = {
  chainId: number;
  /// 這一次部署的識別碼（主機時鐘毫秒）。Anvil 重開後重新部署會得到相同地址，
  /// 只有這個欄位分得出「鏈重開了」。舊的部署檔沒有這個欄位，視為未知。
  deployedAt?: number;
  deployedAtBlock?: number;
  kycRegistry: Address; retirementCertificate: Address; carbonCredit1155: Address; carbonRegistry: Address;
  reserveAttestation: Address;
  feeSchedule: Address;
  settlementToken: Address; listing: Address; cct: Address; carbonPool: Address;
  poolManager: Address; hook: Address; router: Address; accountFactory: Address;
  poolFee: number; tickSpacing: number;
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/// SKIP_V4=1 部署時（目標鏈沒有 EIP-1153），v4 相關地址會是 0。
/// 主市場 Listing、池化、註銷憑證都不受影響，只有 v4 swap 這塊要隱藏。
export function hasV4(d: Pick<Deployment, "poolManager" | "hook" | "router">): boolean {
  return [d.poolManager, d.hook, d.router].every((a) => !!a && a !== ZERO_ADDRESS);
}

export const TIER = { None: 0, Individual: 1, Corporate: 2, SystemContract: 3 } as const;
export const TIER_LABEL = ["未驗證", "自然人", "法人", "系統合約"] as const;
/// 註銷用途：對齊環境部 TCER 登錄系統四種註銷申請書的分類，順序與合約 enum 一致。
export const PURPOSE_LABEL = ["扣除碳費排放量", "自願性碳中和或碳抵換", "溫室氣體增量抵換", "環評承諾事項"] as const;

/// 轄區（國別）。額度能拿來做什麼由核發國的法律決定，所以國別要一路帶到憑證上。
export type Jurisdiction = {
  enabled: boolean;
  domestic: boolean;
  /// 允許的註銷用途 bitmask，1 << PURPOSE index
  purposeMask: number;
  name: string;
  scheme: string;
  registryName: string;
  note: string;
};

/// bytes2 的 "0x5457" ↔ "TW"
export function countryCode(bytes2: string): string {
  const hex = bytes2.replace(/^0x/, "");
  return String.fromCharCode(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16)).replace(/\u0000/g, "");
}

export function countryToBytes2(code: string): `0x${string}` {
  return `0x${code.slice(0, 2).split("").map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

/// 國旗用 Unicode regional indicator 組出來，不放圖檔——少一份要維護的資產，
/// 也不會有「某國國旗政治上該不該顯示」的檔案留在 repo 裡。
export function flagOf(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return "🏳";
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function purposeAllowed(mask: number, purpose: number): boolean {
  return (mask & (1 << purpose)) !== 0;
}
