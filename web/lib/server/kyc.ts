import "server-only";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { TIER } from "@/lib/deployment";
import { ledgerRegisterIdentity } from "./ledger/registry";

export type KycRequest = {
  id: string; createdAt: string; updatedAt: string;
  account: Address; tier: number; idNumber: string; name: string; submittedBy: string;
  status: "pending" | "approved" | "rejected"; reason?: string; txHash?: Hex; identityHash?: Hex; decidedBy?: string;
};

export function validateId(tier: number, idNumber: string) {
  const idn = idNumber.trim().toUpperCase();
  const ok = tier === TIER.Individual ? /^[A-Z][12]\d{8}$/.test(idn) : /^\d{8}$/.test(idn);
  if (!ok) throw new Error(tier === TIER.Individual ? "身分證字號格式不符" : "統一編號格式不符");
  return idn;
}

export function identityHashOf(tier: number, idn: string): Hex {
  const salt = process.env.IDENTITY_SALT ?? "co2exchange-phase0";
  return keccak256(toBytes(`${tier === TIER.Individual ? "TW-ID" : "TW-UBN"}:${idn}:${salt}`));
}

/// 身分驗證服務簽一筆帳本的 identity 事件。
/// 正式環境：這一步之前要驗證工商憑證 / 自然人憑證 / TW FidO 對 account 的簽章與憑證鏈。
export async function attestAndRegister(account: Address, tier: number, idn: string) {
  return ledgerRegisterIdentity(account, tier, identityHashOf(tier, idn));
}
