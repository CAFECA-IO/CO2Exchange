import { encodeAbiParameters, keccak256, parseAbi, recoverTypedDataAddress, toBytes, type Address, type Hex } from "viem";

/// CAFECA 實名（IdentityRegistry v2，CAFECA README §9）在本站的樣子。
///
/// 為什麼放在 lib/ledger 而不是 lib/server：網站（登入、同步）、腳本（kyc:sync）與查核
///（法人帳戶簽章要知道「成員在那個區塊是不是有效 L2」）都要用同一套判斷，而且查核工具不能依賴 Next。
///
/// 幾條規則，全部照 CAFECA 的原始碼與 README 寫，不是照摘要：
///   · 只讀 v2。v1 AttestationRegistry 沒有 nonce、不能撤銷，舊簽章任何人都能重送——CAFECA 明說依賴方不應再讀它。
///   · effectiveLevel：ACTIVE、未過期、簽章者仍有效才等於 level，否則 0（合約的 _effective）。
///   · 簽章者分 PROTOTYPE／PRODUCTION。本站預設只收 PRODUCTION；`CAFECA_ACCEPT_PROTOTYPE=1` 才收原型
///    （測試網展示用。CAFECA 換正式簽章者時會移除原型簽章者，原型期的證明全部降為 0，同步時本站身分跟著失效）。
///   · CAFECA 的 L2 **不等於**本站的 tier 2。本站 tier 2 是法人，只看 subjectType。

/// 已知部署（Boltchain 8018，CAFECA issue #1、#2 的部署紀錄）。`.well-known` 目前沒有公布 MemberValidator，
/// 查核工具也不該依賴對方網站醒著——所以已知的位址寫在這裡，環境變數永遠優先。
export const KNOWN_CAFECA: Record<number, { identityRegistry?: Address; memberValidator?: Address }> = {
  8018: { identityRegistry: "0xFc0E5C11B65aa560fb7187D13f4e1A672894E49c", memberValidator: "0xA6F02E155B599C366C5B632B42Ad605290284315" },
};

export const IDENTITY_REGISTRY_ABI = parseAbi([
  "function statusOf(address account) view returns (uint8 subjectType, uint8 level, uint8 effectiveLevel, uint8 status, uint48 expiry, uint48 issuedAt, bytes2 jurisdiction, uint64 nonce, address signer, uint8 signerCls, bytes32 claimsRoot)",
  "function signerClass(address signer) view returns (uint8)",
  "event Attested(address indexed account, uint8 subjectType, uint8 level, uint48 expiry, bytes32 claimsRoot, bytes2 jurisdiction, address signer, uint64 nonce)",
  "event Suspended(address indexed account, uint8 reason, address by, uint64 nonce)",
  "event Revoked(address indexed account, uint8 reason, address by, uint64 nonce)",
  "event SignerSet(address indexed signer, uint8 signerClass)",
]);

export const MEMBER_VALIDATOR_ABI = parseAbi([
  "event MemberSet(address indexed entity, address indexed member, uint8 role)",
  "function roleOf(address member, address entity) view returns (uint8)",
]);

export type SubjectType = "person" | "entity";
export type SignerClass = "none" | "prototype" | "production";
export type AttStatus = "none" | "active" | "suspended" | "revoked";

export type KycStatus = {
  subjectType: SubjectType;
  level: number;
  effectiveLevel: number;
  status: AttStatus;
  expiry: number;
  jurisdiction: string;
  nonce: string;
  signer: Address;
  signerClass: SignerClass;
};

const SIGNER_CLASS: SignerClass[] = ["none", "prototype", "production"];
const STATUS: AttStatus[] = ["none", "active", "suspended", "revoked"];

export const bytes2ToCountry = (b: Hex): string =>
  b === "0x0000" ? "" : String.fromCharCode(parseInt(b.slice(2, 4), 16), parseInt(b.slice(4, 6), 16)).replace(/\0/g, "");

type ReadContract = (q: { address: Address; abi: typeof IDENTITY_REGISTRY_ABI; functionName: "statusOf"; args: [Address] }) => Promise<unknown>;

export async function readKycStatus(readContract: ReadContract, registry: Address, account: Address): Promise<KycStatus> {
  const r = (await readContract({ address: registry, abi: IDENTITY_REGISTRY_ABI, functionName: "statusOf", args: [account] })) as readonly [
    number, number, number, number, number, number, Hex, bigint, Address, number, Hex,
  ];
  return {
    subjectType: r[0] === 1 ? "entity" : "person",
    level: Number(r[1]),
    effectiveLevel: Number(r[2]),
    status: STATUS[Number(r[3])] ?? "none",
    expiry: Number(r[4]),
    jurisdiction: bytes2ToCountry(r[6]),
    nonce: r[7].toString(),
    signer: r[8],
    signerClass: SIGNER_CLASS[Number(r[9])] ?? "none",
  };
}

/// 本站收不收這一級簽章者簽的證明。
export function signerAccepted(cls: SignerClass, acceptPrototype: boolean): boolean {
  return cls === "production" || (acceptPrototype && cls === "prototype");
}

/// 這份實名現在能不能當本站的身分。不行時回理由（給畫面與同步日誌）。
export function usableStatus(s: KycStatus, acceptPrototype: boolean): string | null {
  if (s.status === "none") return "還沒有在 CAFECA 完成實名驗證";
  if (s.status === "suspended") return "CAFECA 的實名證明已暫停（例如法人代表人異動、身分恢復後待重驗）";
  if (s.status === "revoked") return "CAFECA 的實名證明已撤銷";
  if (s.effectiveLevel < 2) return s.level < 2 ? "CAFECA 實名等級不足（L1 是手機驗證，不是實名）" : "CAFECA 的實名證明已過期或簽章者已失效";
  if (!signerAccepted(s.signerClass, acceptPrototype)) {
    return s.signerClass === "prototype"
      ? "CAFECA 目前的實名是原型簽章（PROTOTYPE），本站正式環境只收正式簽章（PRODUCTION）"
      : "CAFECA 實名的簽章者已失效";
  }
  return null;
}

// ── KYC Credential（CAFECA README §9「可驗證的實名資料」） ──

export const CREDENTIAL_CLAIMS = ["legal_name", "doc_type", "nationality", "pairwise_id", "entity_ubn", "entity_name"] as const;
export const CREDENTIAL_TTL = 10 * 60;
export const ZERO32 = `0x${"0".repeat(64)}` as Hex;

export type KycCredentialMessage = {
  account: Address; audience: string; nonce: string; attestationNonce: string;
  issuedAt: number; expiresAt: number;
  legalName: string; docType: string; nationality: string; pairwiseId: Hex;
  entityUbn: string; entityName: string; disclosed: string;
};
export type KycCredential = { message: KycCredentialMessage; signature: Hex };

export const KYC_CREDENTIAL_TYPES = {
  KycCredential: [
    { name: "account", type: "address" },
    { name: "audience", type: "string" },
    { name: "nonce", type: "string" },
    { name: "attestationNonce", type: "uint64" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "legalName", type: "string" },
    { name: "docType", type: "string" },
    { name: "nationality", type: "string" },
    { name: "pairwiseId", type: "bytes32" },
    { name: "entityUbn", type: "string" },
    { name: "entityName", type: "string" },
    { name: "disclosed", type: "string" },
  ],
} as const;

export function kycCredentialTypedData(chainId: number, identityRegistry: Address, m: KycCredentialMessage) {
  return {
    domain: { name: "CAFECA KYC Credential", version: "1", chainId, verifyingContract: identityRegistry },
    types: KYC_CREDENTIAL_TYPES,
    primaryType: "KycCredential" as const,
    message: { ...m, attestationNonce: BigInt(m.attestationNonce), issuedAt: BigInt(m.issuedAt), expiresAt: BigInt(m.expiresAt) },
  };
}

export type CredentialClaims = {
  legal_name: string | null; doc_type: string | null; nationality: string | null; pairwise_id: Hex | null;
  entity_ubn: string | null; entity_name: string | null;
  credential: { signer: Address; signerClass: SignerClass; attestationNonce: string; issuedAt: number };
};

/// 驗 KYC Credential。照 CAFECA README 的五個步驟：帳戶、網站、這次登入的 nonce、時間；揭露的項目都在使用者
/// 以 Passkey 簽下的 claims 裡；簽章者等於目前證明的簽章者；證明仍有效、nonce 沒變。第 5 步（只收正式簽章）由呼叫端決定。
///
/// 丟 Error 的訊息是給伺服器日誌的；畫面上只說「實名資料驗證沒有通過」。
export async function verifyKycCredential(cred: KycCredential, o: {
  account: Address; audience: string; nonce: string; chainId: number; identityRegistry: Address;
  kyc: KycStatus; granted: string[]; now: number;
}): Promise<CredentialClaims> {
  const m = cred?.message;
  if (!m || typeof cred.signature !== "string") throw new Error("KYC Credential 格式錯誤");
  if (typeof m.account !== "string" || m.account.toLowerCase() !== o.account.toLowerCase()) throw new Error("KYC Credential 不屬於這個帳戶");
  if (m.audience !== o.audience) throw new Error("KYC Credential 不是發給本站的");
  if (m.nonce !== o.nonce) throw new Error("KYC Credential 不是這次登入簽發的");
  if (!Number.isInteger(m.issuedAt) || !Number.isInteger(m.expiresAt) || m.issuedAt > o.now + 60 || m.expiresAt < o.now || m.expiresAt - m.issuedAt > CREDENTIAL_TTL) {
    throw new Error("KYC Credential 已過期或時間不合理");
  }
  const disclosed = m.disclosed ? m.disclosed.split(",") : [];
  if (disclosed.some((c) => !o.granted.includes(c))) throw new Error("KYC Credential 揭露了使用者沒有同意的資料");
  const signer = await recoverTypedDataAddress({ ...kycCredentialTypedData(o.chainId, o.identityRegistry, m), signature: cred.signature }).catch(() => null);
  if (!signer || signer.toLowerCase() !== o.kyc.signer.toLowerCase() || o.kyc.signerClass === "none") {
    throw new Error("KYC Credential 的簽章者不是目前證明的簽章者");
  }
  if (o.kyc.status !== "active" || o.kyc.effectiveLevel < 2) throw new Error("實名證明已失效（暫停、撤銷或過期）");
  if (String(m.attestationNonce) !== o.kyc.nonce) throw new Error("實名證明已變更，這份 KYC Credential 失效");
  const has = (c: string) => disclosed.includes(c);
  return {
    legal_name: has("legal_name") ? m.legalName : null,
    doc_type: has("doc_type") ? m.docType : null,
    nationality: has("nationality") ? m.nationality : null,
    pairwise_id: has("pairwise_id") && m.pairwiseId !== ZERO32 ? m.pairwiseId : null,
    entity_ubn: has("entity_ubn") ? m.entityUbn : null,
    entity_name: has("entity_name") ? m.entityName : null,
    credential: { signer, signerClass: o.kyc.signerClass, attestationNonce: String(m.attestationNonce), issuedAt: m.issuedAt },
  };
}

// ── 對應到本站帳本的身分 ──

export type LedgerIdentity = {
  tier: 1 | 2;
  expiry: bigint;
  jurisdiction: string;
  /// identityRoot 的葉子。自然人用 pairwise_id（CAFECA 給本站的同一人識別碼），法人用統一編號——
  /// 都加本站的鹽，公開的 identityRoot 推不回原值，也和人工審核那條路的雜湊同一套格式（法人可以互相比對）
  identityHash: Hex;
  /// 出金收款帳戶的戶名要等於它（自然人：證件姓名；法人：商工登記名稱）
  name: string;
};

/// 一份已驗證的 CAFECA 實名 → 本站帳本的身分。缺了必要的資料就回理由，不要用半套資料登記。
export function ledgerIdentityFrom(s: KycStatus, c: Pick<CredentialClaims, "legal_name" | "nationality" | "pairwise_id" | "entity_ubn" | "entity_name">, salt: string):
  { ok: true; identity: LedgerIdentity } | { ok: false; reason: string } {
  const expiry = BigInt(s.expiry);
  if (s.subjectType === "entity") {
    const ubn = (c.entity_ubn ?? "").trim();
    if (!/^\d{8}$/.test(ubn)) return { ok: false, reason: "以公司身分登入時要同意提供統一編號（entity_ubn）" };
    if (!c.entity_name?.trim()) return { ok: false, reason: "以公司身分登入時要同意提供公司名稱（entity_name）" };
    return { ok: true, identity: {
      tier: 2, expiry, jurisdiction: s.jurisdiction || "TW",
      identityHash: keccak256(toBytes(`TW-UBN:${ubn}:${salt}`)), name: c.entity_name.trim(),
    } };
  }
  if (!c.pairwise_id) return { ok: false, reason: "要同意提供同一人識別碼（pairwise_id）——本站用它確認一個人只有一個交易帳戶" };
  if (!c.legal_name?.trim()) return { ok: false, reason: "要同意提供證件姓名（legal_name）——出金只能匯到與實名相同戶名的帳戶" };
  return { ok: true, identity: {
    tier: 1, expiry, jurisdiction: (c.nationality || s.jurisdiction || "TW").toUpperCase(),
    identityHash: keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "string" }], ["CAFECA-PAIRWISE", c.pairwise_id, salt])),
    name: c.legal_name.trim(),
  } };
}

// ── 同步：CAFECA 的狀態變了，帳本身分要不要跟著變 ──

export type SyncPlan = {
  action: "ok" | "renewed" | "lapsed" | "restored" | "error";
  detail: string;
  /// 要寫進帳本的 identity 事件（沒有就不寫）
  identity?: { tier: number; identityHash: Hex; expiry: bigint; jurisdiction: string };
  /// 存查紀錄要改成什麼
  record?: { status: "approved" | "lapsed"; reason?: string; attestationNonce: string; signer: Address; signerClass: SignerClass; expiry: number };
};

/// 純函式：網站（登入時）與 `npm run kyc:sync` 共用同一套判斷。
///
///   · CAFECA 那邊不能用了（暫停、撤銷、過期、簽章者退役、主體類型變了）→ 帳本身分的效期改成現在（失效）
///   · 還能用 → 效期跟著 CAFECA（重新簽發會延長）
///   · 之前失效過，而 CAFECA **重新簽發**了（nonce 變了，例如恢復後重驗通過）→ 恢復
///     只是 nonce 沒變的「又能用了」（例如簽章者被重新登記）不自動恢復——那種情況要使用者重新登入、出示新的 credential
export function syncPlan(o: {
  rec: { tier: number; status: "approved" | "lapsed"; identityHash: Hex | undefined; attestationNonce: string | undefined; reason?: string };
  cur: { tier: number; identityHash: Hex; expiry: bigint; jurisdiction: string } | null;
  kyc: KycStatus; acceptPrototype: boolean; now: bigint;
}): SyncPlan {
  const { rec, cur, kyc, now } = o;
  const record = (status: "approved" | "lapsed", reason?: string) =>
    ({ status, reason, attestationNonce: kyc.nonce, signer: kyc.signer, signerClass: kyc.signerClass, expiry: kyc.expiry });
  const unusable = usableStatus(kyc, o.acceptPrototype)
    ?? ((kyc.subjectType === "entity" ? 2 : 1) !== rec.tier ? "CAFECA 的主體類型和本站登記的不同" : null);
  if (unusable) {
    return {
      action: "lapsed", detail: unusable,
      identity: cur && cur.expiry > now ? { tier: cur.tier, identityHash: cur.identityHash, expiry: now, jurisdiction: cur.jurisdiction } : undefined,
      record: rec.status === "lapsed" && rec.reason === unusable ? undefined : { ...record("lapsed", unusable), attestationNonce: rec.attestationNonce ?? kyc.nonce },
    };
  }
  const reissued = rec.attestationNonce !== kyc.nonce;
  if (rec.status === "lapsed" && !reissued) return { action: "lapsed", detail: rec.reason ?? "已失效，等使用者重新驗證" };
  if (!cur || !rec.identityHash) return { action: "error", detail: "帳本裡沒有這個帳戶的身分" };
  const wantExpiry = BigInt(kyc.expiry);
  const identity = cur.expiry !== wantExpiry || rec.status === "lapsed"
    ? { tier: rec.tier, identityHash: rec.identityHash, expiry: wantExpiry, jurisdiction: cur.jurisdiction } : undefined;
  if (rec.status === "lapsed") return { action: "restored", detail: "CAFECA 重新簽發，帳本身分恢復", identity, record: record("approved") };
  if (identity) return { action: "renewed", detail: `效期改為 ${new Date(kyc.expiry * 1000).toISOString().slice(0, 10)}`, identity, record: record("approved") };
  return { action: "ok", detail: "有效", record: record("approved") };
}
