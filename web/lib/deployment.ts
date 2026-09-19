import type { Address } from "viem";

export type Deployment = {
  chainId: number;
  kycRegistry: Address; retirementCertificate: Address; carbonCredit1155: Address; carbonRegistry: Address;
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
export const PURPOSE_LABEL = ["自願抵銷", "碳費扣抵", "CBAM 申報", "其他"] as const;
