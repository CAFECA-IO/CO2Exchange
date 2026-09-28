import { hashTypedData, type Address, type Hex } from "viem";
import { KIND, LOG_VERSION, payloadHash, type Event, type EventOf } from "./events.ts";

/// 帳本 v2 的簽章格式。
///
/// **使用者簽的**要讓人看得懂：CAFECA 錢包會把 EIP-712 的每一個欄位列給使用者看，
/// 所以掛單、撤單、註銷、登錄專案各有自己的型別，欄位就是他同意的內容。
///
/// **授權金鑰簽的**（核發、身分、凍結、費率…）由伺服器或治理 Safe 簽，沒有人需要在錢包裡讀它，
/// 所以統一成一個型別：`LedgerEvent(version, kind, payload)`，payload 是事件內容的雜湊。
/// 統一的好處是查核者只需要一支驗證程式，而且新增事件種類不必新增簽章格式。
///
/// 兩個網域的 `verifyingContract` 都是帳本合約：換一個部署就是不同的簽章，
/// 測試網簽的東西搬不到正式網。CAFECA 錢包拒絕指向使用者帳戶、EntryPoint 或 CAFECA 系統合約的
/// 網域——帳本合約不是那幾類，語意上也對。
///
/// 數值在線上一律用十進位字串（JSON 沒有 bigint，CAFECA 也要求字串）；算 digest 時轉回 bigint。

export type Domains = { chainId: number; ledger: Address };

export const USER_DOMAIN_NAME = "TideBit-DeFi Carbon Exchange";
export const AUTH_DOMAIN_NAME = "TideBit-DeFi Ledger";
export const DOMAIN_VERSION = String(LOG_VERSION);

const userDomain = (d: Domains) => ({ name: USER_DOMAIN_NAME, version: DOMAIN_VERSION, chainId: d.chainId, verifyingContract: d.ledger });
const authDomain = (d: Domains) => ({ name: AUTH_DOMAIN_NAME, version: DOMAIN_VERSION, chainId: d.chainId, verifyingContract: d.ledger });

export const USER_TYPES = {
  PlaceOrder: [
    { name: "account", type: "address" },
    { name: "side", type: "string" },
    { name: "batchId", type: "uint256" },
    { name: "country", type: "string" },
    { name: "amountKg", type: "uint256" },
    { name: "pricePerTonne", type: "uint256" },
    { name: "minFillKg", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
  CancelOrder: [
    { name: "account", type: "address" },
    { name: "orderSeq", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
  RetireCredits: [
    { name: "account", type: "address" },
    { name: "batchId", type: "uint256" },
    { name: "amountKg", type: "uint256" },
    { name: "beneficiary", type: "string" },
    { name: "beneficiaryHash", type: "bytes32" },
    { name: "purpose", type: "uint8" },
    { name: "memo", type: "string" },
    { name: "nonce", type: "uint256" },
  ],
  RequestWithdrawal: [
    { name: "account", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "payoutRef", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
  RegisterProject: [
    { name: "account", type: "address" },
    { name: "name", type: "string" },
    { name: "methodology", type: "string" },
    { name: "location", type: "string" },
    { name: "metadataURI", type: "string" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const AUTH_TYPES = {
  LedgerEvent: [
    { name: "version", type: "uint16" },
    { name: "kind", type: "uint8" },
    { name: "payload", type: "bytes32" },
  ],
} as const;

export type UserKind = "place" | "cancel" | "retire" | "project" | "withdraw";
const PRIMARY: Record<UserKind, keyof typeof USER_TYPES> = {
  place: "PlaceOrder", cancel: "CancelOrder", retire: "RetireCredits", project: "RegisterProject", withdraw: "RequestWithdrawal",
};

/// 使用者事件 → 當初被簽的那則訊息（十進位字串版，交給錢包用）。
/// **欄位只能從事件取**：任何從別處補的預設值都會讓 digest 算不回去。
export function userMessageOf(e: EventOf<UserKind>): Record<string, string | number> {
  const s = (x: bigint) => x.toString();
  switch (e.kind) {
    case "place":
      return { account: e.account, side: e.side, batchId: s(e.batchId), country: e.country, amountKg: s(e.amountKg),
        pricePerTonne: s(e.pricePerTonne), minFillKg: s(e.minFillKg), expiry: s(e.expiry), nonce: s(e.nonce) };
    case "cancel":
      return { account: e.account, orderSeq: s(e.orderSeq), nonce: s(e.nonce) };
    case "retire":
      return { account: e.account, batchId: s(e.batchId), amountKg: s(e.amountKg), beneficiary: e.beneficiary,
        beneficiaryHash: e.beneficiaryHash, purpose: e.purpose, memo: e.memo, nonce: s(e.nonce) };
    case "project":
      return { account: e.account, name: e.name, methodology: e.methodology, location: e.location, metadataURI: e.metadataURI, nonce: s(e.nonce) };
    case "withdraw":
      return { account: e.account, amount: s(e.amount), payoutRef: e.payoutRef, nonce: s(e.nonce) };
  }
}

const NUMERIC = new Set(["batchId", "amountKg", "pricePerTonne", "minFillKg", "expiry", "nonce", "orderSeq", "amount"]);

/// 交給錢包簽的那一包。前端與後端必須用同一個函式產生——兩邊各組一份是這類協定最常見的壞法。
export function userTypedData(d: Domains, kind: UserKind, message: Record<string, string | number>) {
  const primaryType = PRIMARY[kind];
  return { domain: userDomain(d), types: { [primaryType]: USER_TYPES[primaryType] }, primaryType, message };
}

export function userDigest(d: Domains, kind: UserKind, message: Record<string, string | number>): Hex {
  const m: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(message)) m[k] = NUMERIC.has(k) ? BigInt(String(v)) : v;
  return hashTypedData({ ...userTypedData(d, kind, message), message: m } as Parameters<typeof hashTypedData>[0]);
}

export function authTypedData(d: Domains, e: Event) {
  return {
    domain: authDomain(d),
    types: AUTH_TYPES,
    primaryType: "LedgerEvent" as const,
    message: { version: LOG_VERSION, kind: KIND[e.kind], payload: payloadHash(e) },
  };
}

/// 這一筆事件要驗的 digest。鏈上鏡像事件（入金／出金確認／金鑰）回 null：它們由 ChainRef 背書，不是簽章。
export function digestOf(d: Domains, e: Event): Hex | null {
  if (e.kind === "cashDeposit" || e.kind === "cashWithdraw" || e.kind === "userKey") return null;
  if (e.kind === "place" || e.kind === "cancel" || e.kind === "retire" || e.kind === "project" || e.kind === "withdraw") {
    return userDigest(d, e.kind, userMessageOf(e));
  }
  return hashTypedData(authTypedData(d, e));
}
