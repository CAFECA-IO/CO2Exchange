import "server-only";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { TIER } from "@/lib/deployment";
import { maskIdNumber } from "@/lib/crypto/sealed";
import { ledgerRegisterIdentity } from "./ledger/registry";
import { openField, sealField } from "./sealed";

/// 身分驗證申請。**證號與姓名只以密文保存**（lib/server/sealed.ts）；證號在審核完（核准或駁回）
/// 之後就刪掉密文，只留遮罩與帳本裡的 identityHash——核准需要的只是那個雜湊，留著證號沒有用處，只有風險。
export type KycRequest = {
  id: string; createdAt: string; updatedAt: string;
  account: Address; tier: number; submittedBy: string;
  /// 證號的密文。審核完就移除
  idNumberSealed?: string;
  idNumberMasked: string;
  /// 姓名／公司名稱的密文（出金收款帳戶的戶名要和它相同）
  nameSealed?: string;
  /// superseded：同一個帳戶後來有新的 CAFECA 實名紀錄取代它；lapsed：CAFECA 的實名暫停、撤銷或過期，帳本身分已失效
  status: "pending" | "approved" | "rejected" | "superseded" | "lapsed"; reason?: string; txHash?: Hex; identityHash?: Hex; decidedBy?: string;
  /// 來源。沒有這個欄位的是人工審核（舊資料）
  source?: "manual" | "cafeca";
  /// CAFECA 實名的存查資訊（不含個資）
  cafeca?: { subjectType: "person" | "entity"; attestationNonce: string; signer: Hex; signerClass: string; expiry: number; jurisdiction: string; docType?: string | null; checkedAt: string };
  /// 舊資料（遷移前）才有的明文欄位。`npm run data:protect` 會把它們改成密文或刪掉；程式不再寫入
  idNumber?: string; name?: string;
};

const C = "kyc-requests";

/// 新申請要寫進 store 的欄位：證號與姓名加密、另存遮罩。
export function sealKyc(account: Address, idn: string, name: string) {
  return {
    idNumberSealed: sealField(C, "idNumber", account, idn),
    idNumberMasked: maskIdNumber(idn),
    ...(name ? { nameSealed: sealField(C, "name", account, name) } : {}),
  };
}

/// 審核時解開證號（只有核准那一刻需要，用來算 identityHash）。
export function idNumberOf(r: KycRequest): string {
  if (r.idNumberSealed) return openField(C, "idNumber", r.account, r.idNumberSealed);
  if (r.idNumber) return r.idNumber; // 遷移前的舊資料
  throw new Error("這筆申請的證號已經刪除（審核過了）");
}

export function nameOf(r: KycRequest): string {
  if (r.nameSealed) return openField(C, "name", r.account, r.nameSealed);
  return r.name ?? "";
}

/// 審核完要一起寫入的變更：移除證號（密文與任何舊的明文）。
export const purgeIdNumber = { idNumberSealed: undefined, idNumber: undefined } as const;

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
/// 人工審核那條路（CAFECA 尚不支援的主體）。CAFECA 實名走 kyc-cafeca.ts。
export async function attestAndRegister(account: Address, tier: number, idn: string) {
  return ledgerRegisterIdentity(account, tier, identityHashOf(tier, idn));
}
