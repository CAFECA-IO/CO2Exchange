import type { Address } from "viem";

export type Deployment = {
  chainId: number;
  kycRegistry: Address; retirementCertificate: Address; carbonCredit1155: Address; carbonRegistry: Address;
  settlementToken: Address; listing: Address; cct: Address; carbonPool: Address;
  poolManager: Address; hook: Address; router: Address; accountFactory: Address;
  poolFee: number; tickSpacing: number;
};

export const TIER = { None: 0, Individual: 1, Corporate: 2, SystemContract: 3 } as const;
export const TIER_LABEL = ["未驗證", "自然人", "法人", "系統合約"] as const;
export const PURPOSE_LABEL = ["自願抵銷", "碳費扣抵", "CBAM 申報", "其他"] as const;
