import "server-only";
import type { Address } from "viem";
import { ledgerIdentityFrom, readKycStatus, syncPlan, usableStatus, type CredentialClaims, type KycStatus } from "@/lib/ledger/cafeca-identity";
import { maskIdNumber } from "@/lib/crypto/sealed";
import { IS_LOCAL_CHAIN } from "./chain";
import { cafecaConfig, identityClient } from "./cafeca/config";
import { all, insert, patch } from "./store";
import { type KycRequest } from "./kyc";
import { sealField } from "./sealed";
import { ledgerRegisterIdentity } from "./ledger/registry";
import { ledgerView } from "./ledger/view";

/// 以 CAFECA 的實名當本站的 KYC（CAFECA issue #1、#2；分析見專案文件 kyc-cafeca-feasibility.md）。
///
/// 流程：使用者登入時同意提供實名資料 → verify.ts 驗過 KYC Credential → 這裡把它登記成帳本的身分事件
///（仍由本站的身分驗證服務金鑰簽，查核者對照鏈上的 IdentityRegistry 就能核對）。之後由 `syncCafecaIdentities`
/// 定期重查：CAFECA 暫停、撤銷、過期或簽章者退役時，帳本身分跟著失效。
///
/// 本站**不再收身分證號**：自然人只拿到證件姓名與同一人識別碼（pairwise_id，每個網站不同、推不回證號），
/// 法人拿到統一編號與公司名稱（公開的登記資料）。姓名以密文存放，只用來比對出金戶名。

const C = "kyc-requests";

/// 收不收 CAFECA 的原型簽章（PROTOTYPE）。正式環境只收正式簽章；本機鏈一律收（沒有正式簽章者可言）。
export const acceptPrototype = () => IS_LOCAL_CHAIN || process.env.CAFECA_ACCEPT_PROTOTYPE === "1";

const salt = () => process.env.IDENTITY_SALT ?? "co2exchange-phase0";
const low = (a: string) => a.toLowerCase();
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

export type Adoption =
  | { adopted: true; tier: 1 | 2; changed: boolean; txHash?: string }
  | { adopted: false; reason: string };

/// 這個帳戶目前的 CAFECA 實名紀錄（最新一筆）。
export function cafecaRecordOf(account: Address): KycRequest | null {
  return all<KycRequest>(C).filter((r) => low(r.account) === low(account) && r.source === "cafeca").at(-1) ?? null;
}

/// 別的帳戶是不是已經用同一個人（或同一個統編）登記過、而且還有效。
function takenBy(account: Address, identityHash: string): string | null {
  const s = ledgerView().state;
  const t = nowSec();
  for (const id of s.identities.values()) {
    if (low(id.account) === low(account)) continue;
    if (id.identityHash.toLowerCase() === identityHash.toLowerCase() && id.expiry > t && !id.frozen) return id.account;
  }
  return null;
}

/// 最近一次登入時採用的結果（給身分頁說明「為什麼還沒有身分」）。每個帳戶一筆。
type LastAdoption = { id: string; createdAt: string; updatedAt: string; account: Address; adopted: boolean; reason?: string; at: string };
const L = "kyc-cafeca-last";
export function lastAdoptionOf(account: Address): LastAdoption | null {
  return all<LastAdoption>(L).find((r) => low(r.account) === low(account)) ?? null;
}
function remember(account: Address, a: Adoption) {
  const row = { account, adopted: a.adopted, reason: a.adopted ? undefined : a.reason, at: new Date().toISOString() };
  const cur = lastAdoptionOf(account);
  if (cur) patch<LastAdoption>(L, cur.id, row); else insert<LastAdoption>(L, row);
}

/// 登入時呼叫：已驗證的實名 → 帳本身分。不擋登入；結果記下來給身分頁顯示。
export async function adoptCafecaIdentity(account: Address, kyc: KycStatus | null, cred: CredentialClaims | null, credentialError?: string): Promise<Adoption> {
  let a: Adoption;
  try { a = await adopt(account, kyc, cred, credentialError); }
  catch (e) { a = { adopted: false, reason: `登記帳本身分失敗：${(e as Error).message}` }; }
  remember(account, a);
  return a;
}

async function adopt(account: Address, kyc: KycStatus | null, cred: CredentialClaims | null, credentialError?: string): Promise<Adoption> {
  if (!kyc) return { adopted: false, reason: "讀不到 CAFECA 的實名狀態（沒有設定 IdentityRegistry v2，或登入時沒有同意提供實名等級）" };
  const unusable = usableStatus(kyc, acceptPrototype());
  if (unusable) return { adopted: false, reason: unusable };
  if (!cred) return { adopted: false, reason: credentialError ? `實名資料驗證沒有通過（${credentialError}）` : "登入時沒有同意提供實名資料（姓名與同一人識別碼，或公司的統編與名稱）" };
  const mapped = ledgerIdentityFrom(kyc, cred, salt());
  if (!mapped.ok) return { adopted: false, reason: mapped.reason };
  const want = mapped.identity;

  const other = takenBy(account, want.identityHash);
  if (other) {
    return { adopted: false, reason: want.tier === 2
      ? `這個統一編號已經綁定另一個交易帳戶（${other.slice(0, 6)}…${other.slice(-4)}）。一家公司只能有一個交易帳戶`
      : `你已經有另一個交易帳戶（${other.slice(0, 6)}…${other.slice(-4)}）。一個人只能有一個交易帳戶` };
  }

  const cur = ledgerView().state.identities.get(low(account));
  const same = cur && cur.tier === want.tier && cur.identityHash.toLowerCase() === want.identityHash.toLowerCase()
    && cur.expiry === want.expiry && cur.jurisdiction === want.jurisdiction && cur.expiry > nowSec();
  let txHash: string | undefined;
  if (!same) {
    const r = await ledgerRegisterIdentity(account, want.tier, want.identityHash, { expiry: want.expiry, jurisdiction: want.jurisdiction });
    txHash = r.txHash;
  }

  // 存查紀錄：同一帳戶的舊 CAFECA 紀錄標成被取代，留一筆最新的（出金戶名比對讀最新一筆）
  const prev = cafecaRecordOf(account);
  const meta: KycRequest["cafeca"] = {
    subjectType: kyc.subjectType, attestationNonce: kyc.nonce, signer: kyc.signer, signerClass: kyc.signerClass,
    expiry: kyc.expiry, jurisdiction: want.jurisdiction, docType: cred.doc_type, checkedAt: new Date().toISOString(),
  };
  const nameSame = prev?.status === "approved" && prev.identityHash?.toLowerCase() === want.identityHash.toLowerCase()
    && prev.cafeca?.attestationNonce === kyc.nonce && prev.tier === want.tier;
  if (nameSame && !txHash) {
    patch<KycRequest>(C, prev!.id, { cafeca: meta });
    return { adopted: true, tier: want.tier, changed: false };
  }
  for (const r of all<KycRequest>(C)) {
    if (low(r.account) === low(account) && r.source === "cafeca" && r.status === "approved") patch<KycRequest>(C, r.id, { status: "superseded" });
  }
  insert<KycRequest>(C, {
    account, tier: want.tier, submittedBy: account, status: "approved", source: "cafeca", decidedBy: "cafeca",
    idNumberMasked: want.tier === 2 ? maskIdNumber(cred.entity_ubn ?? "") : "CAFECA 實名",
    nameSealed: sealField(C, "name", account, want.name),
    identityHash: want.identityHash, txHash: txHash as KycRequest["txHash"], cafeca: meta,
  });
  return { adopted: true, tier: want.tier, changed: true, txHash };
}

export type SyncResult = { account: Address; action: "ok" | "renewed" | "lapsed" | "restored" | "error"; detail: string };

/// 重查一個帳戶：CAFECA 那邊失效了就讓帳本身分到期；重新簽發（例如恢復後重驗）就延長效期。
///
/// 只處理「最新的身分來自 CAFECA」的帳戶——人工審核的身分不受 CAFECA 狀態影響。
export async function syncCafecaIdentity(account: Address): Promise<SyncResult> {
  const rec = cafecaRecordOf(account);
  if (!rec || (rec.status !== "approved" && rec.status !== "lapsed")) return { account, action: "ok", detail: "不是 CAFECA 實名" };
  const latestAny = all<KycRequest>(C).filter((r) => low(r.account) === low(account) && (r.status === "approved" || r.status === "lapsed")).at(-1);
  if (latestAny && latestAny.source !== "cafeca") return { account, action: "ok", detail: "最新的身分來自人工審核" };

  const cfg = await cafecaConfig();
  const registry = cfg.contracts.identityRegistry;
  if (!registry) return { account, action: "error", detail: "沒有設定 IdentityRegistry v2" };
  const { client } = await identityClient();
  let kyc: KycStatus;
  try { kyc = await readKycStatus((q) => client.readContract(q as never), registry, account); }
  catch (e) { return { account, action: "error", detail: `讀不到實名狀態：${(e as Error).message.split("\n")[0]}` }; }

  const id = ledgerView().state.identities.get(low(account));
  const plan = syncPlan({
    rec: { tier: rec.tier, status: rec.status as "approved" | "lapsed", identityHash: rec.identityHash, attestationNonce: rec.cafeca?.attestationNonce, reason: rec.reason },
    cur: id ? { tier: id.tier, identityHash: id.identityHash, expiry: id.expiry, jurisdiction: id.jurisdiction } : null,
    kyc, acceptPrototype: acceptPrototype(), now: nowSec(),
  });
  if (plan.identity) {
    await ledgerRegisterIdentity(account, plan.identity.tier, plan.identity.identityHash, { expiry: plan.identity.expiry, jurisdiction: plan.identity.jurisdiction });
  }
  if (plan.record) {
    patch<KycRequest>(C, rec.id, {
      status: plan.record.status, reason: plan.record.reason,
      cafeca: { ...rec.cafeca!, attestationNonce: plan.record.attestationNonce, signer: plan.record.signer, signerClass: plan.record.signerClass, expiry: plan.record.expiry, checkedAt: new Date().toISOString() },
    });
  }
  return { account, action: plan.action, detail: plan.detail };
}

/// 所有以 CAFECA 實名登記的帳戶。
export async function syncCafecaIdentities(): Promise<SyncResult[]> {
  const accounts = [...new Set(all<KycRequest>(C).filter((r) => r.source === "cafeca").map((r) => low(r.account)))] as Address[];
  const out: SyncResult[] = [];
  for (const a of accounts) {
    try { out.push(await syncCafecaIdentity(a)); }
    catch (e) { out.push({ account: a, action: "error", detail: (e as Error).message }); }
  }
  return out;
}
