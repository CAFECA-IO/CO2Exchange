import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { buildTree, leaf, type Proof } from "./merkle.ts";

/// 帳本 v2：交易所裡**每一個角色的每一個動作**，照順序、接成一條雜湊鏈。
///
/// v1（lib/bank/log.ts）只記交易：存入、掛單、撤單。v2 把登錄簿與身分也搬進來——
/// 專案登錄、核發、身分驗證、凍結、註銷、對帳報告——因為鏈上只剩每一期的壓縮證據
/// （設計見專案文件 design-v4-proofs-only.md）。鏈上沒有登錄簿之後，**這份 log 就是登錄簿**。
///
/// ## 只記輸入，不記結果（沿用 v1 的原則）
///
/// 成交、憑證、批次餘額都**不記在 log 裡**，它們是引擎從輸入算出來的。記了結果就有兩份真相。
///
/// ## 每一筆都帶三樣東西
///
///   · **授權它的簽章**：使用者的（掛單、註銷、登錄專案）或授權金鑰的（核發、身分、凍結…）。
///     授權金鑰清單在鏈上，重播時逐筆驗證簽章者在當時確實有那個角色。
///   · **收單時的區塊高度**（`atBlock`）：CAFECA 帳戶是 ERC-1271 合約錢包，簽章有效與否取決於
///     當時帳戶上的金鑰；授權清單也會變動。重驗必須在那個高度查（需要 archive 節點）。
///   · **邏輯時間**（`at`）：收單時給定。引擎判斷過期只看它，不讀牆上時鐘。
///
/// ## 正規化編碼
///
/// ABI 編碼，前面帶版本與種類。**種類號只能往後加，不能重排、不能重用**——它進雜湊。
/// v2 與 v1 的事件格式不相容，所以版本號是 2；v1 從來沒有在正式環境產生過資料。

export const LOG_VERSION = 2;

export const KIND = {
  cashDeposit: 1,
  cashWithdraw: 2,
  jurisdiction: 3,
  policy: 4,
  fees: 5,
  identity: 6,
  freeze: 7,
  project: 8,
  importProject: 9,
  projectStatus: 10,
  issue: 11,
  place: 12,
  cancel: 13,
  retire: 14,
  certDocument: 15,
  certOfficial: 16,
  reserveReport: 17,
  reserveAttest: 18,
  /// CAFECA 帳戶的 passkey 公鑰（鏈上 KeyAdded 的鏡像，帶座標）。查核驗 WebAuthn 簽章時用，不改變任何狀態
  userKey: 19,
  /// 使用者簽的提領請求（2026-09-29 新增，規則第 3 版）：把帳本裡的現金移到「待提領」，之後憑證據從帳本合約領回
  withdraw: 20,
} as const;
export type Kind = keyof typeof KIND;

/// 鏈上事件的憑據（只有 cashDeposit / cashWithdraw 有）。重播的人拿它回鏈上核對。
export type ChainRef = { txHash: Hex; block: bigint; logIndex: number };

type Base = { seq: bigint; at: bigint; atBlock: bigint };
/// 授權金鑰簽的事件
type Auth = { signer: Address; signature: Hex };
/// 使用者簽的事件（signer 就是 account）
type User = { account: Address; nonce: bigint; signature: Hex };

export type ReserveCredit = { country: string; custodian: string; accountRef: string; heldKg: bigint; ledgerKg: bigint; statementHash: Hex };
export type ReserveCash = { trustee: string; accountRef: string; balance: bigint; tokenSupply: bigint; statementHash: Hex };

export type Event = Base &
  (
    | { kind: "cashDeposit"; ref: ChainRef; account: Address; amount: bigint }
    | { kind: "cashWithdraw"; ref: ChainRef; account: Address; amount: bigint }
    | { kind: "userKey"; ref: ChainRef; account: Address; keyId: Hex; qx: Hex; qy: Hex; rpIdHash: Hex; keyKind: number; validator: Address }
    | ({ kind: "jurisdiction"; country: string; enabled: boolean; domestic: boolean; purposeMask: number; name: string; scheme: string; registryName: string; note: string } & Auth)
    | ({ kind: "policy"; individualTransfer: boolean; individualRetire: boolean; treasury: Address } & Auth)
    /// country 為空字串 = 預設費率
    | ({ kind: "fees"; country: string; tradeBps: bigint; retireFeePerTonne: bigint } & Auth)
    | ({ kind: "identity"; account: Address; tier: number; expiry: bigint; jurisdiction: string; identityHash: Hex; nonce: bigint; deadline: bigint } & Auth)
    /// target: 0 = 帳戶、1 = 批次
    | ({ kind: "freeze"; target: number; account: Address; batchId: bigint; frozen: boolean; reason: string } & Auth)
    | ({ kind: "project"; name: string; methodology: string; location: string; metadataURI: string } & User)
    | ({ kind: "importProject"; owner: Address; country: string; scheme: string; name: string; methodology: string; location: string; metadataURI: string } & Auth)
    | ({ kind: "projectStatus"; projectId: bigint; active: boolean } & Auth)
    | ({ kind: "issue"; projectId: bigint; monitoringStart: bigint; monitoringEnd: bigint; amountKg: bigint; serialHash: Hex; reportHash: Hex; attestationId: bigint; deadline: bigint } & Auth)
    /// 賣單指定 batchId；買單 batchId = 0（不挑批次）、country 可空（不限核發國）
    | ({ kind: "place"; side: "buy" | "sell"; batchId: bigint; country: string; amountKg: bigint; pricePerTonne: bigint; minFillKg: bigint; expiry: bigint } & User)
    | ({ kind: "cancel"; orderSeq: bigint } & User)
    /// 提領請求：amount 從可動用現金移到待提領。鏈上領回時（CashWithdrawn）再由鏡像事件銷帳
    | ({ kind: "withdraw"; amount: bigint } & User)
    /// purpose：0 碳費扣除、1 自願性碳中和、2 增量抵換、3 環評承諾（對齊環境部註銷申請書四類）
    | ({ kind: "retire"; batchId: bigint; amountKg: bigint; beneficiary: string; beneficiaryHash: Hex; purpose: number; memo: string } & User)
    | ({ kind: "certDocument"; certId: bigint; documentHash: Hex } & Auth)
    | ({ kind: "certOfficial"; certId: bigint; officialRef: string; officialAt: bigint } & Auth)
    | ({ kind: "reserveReport"; period: number; asOf: bigint; credits: ReserveCredit[]; cash: ReserveCash; documentHash: Hex } & Auth)
    /// status：1 已查核相符、2 已查核有差異
    | ({ kind: "reserveAttest"; reportId: bigint; status: number; auditorName: string; note: string } & Auth)
  );

export type EventOf<K extends Kind> = Extract<Event, { kind: K }>;

/// 誰簽這一筆。鏈上事件（存入／提領）沒有簽章者，由 ChainRef 背書。
export function signerOf(e: Event): Address | null {
  if (e.kind === "cashDeposit" || e.kind === "cashWithdraw" || e.kind === "userKey") return null;
  if ("signer" in e) return e.signer;
  return e.account;
}

export const USER_KINDS = new Set<Kind>(["project", "place", "cancel", "retire", "withdraw"]);
export const isUserEvent = (e: Event): e is Extract<Event, User> => USER_KINDS.has(e.kind);

export const countryToBytes2 = (c: string): Hex => {
  const s = (c || "\u0000\u0000").padEnd(2, "\u0000").slice(0, 2);
  return `0x${s.charCodeAt(0).toString(16).padStart(2, "0")}${s.charCodeAt(1).toString(16).padStart(2, "0")}`;
};

const ZADDR: Address = "0x0000000000000000000000000000000000000000";

/// 一筆事件的**內容**（不含序號、時間、簽章）。授權金鑰簽的就是它的雜湊。
///
/// 序號與時間是交易所收單時給的，簽的人在簽的當下不知道，所以不能在被簽的內容裡。
export function payloadOf(e: Event): Hex {
  const T = (types: string[], values: unknown[]) =>
    encodeAbiParameters(types.map((type) => ({ type })), values as never);
  switch (e.kind) {
    case "cashDeposit":
    case "cashWithdraw":
      return T(["bytes32", "uint256", "uint32", "address", "uint256"], [e.ref.txHash, e.ref.block, e.ref.logIndex, e.account, e.amount]);
    case "userKey":
      return T(["bytes32", "uint256", "uint32", "address", "bytes32", "bytes32", "bytes32", "bytes32", "uint8", "address"],
        [e.ref.txHash, e.ref.block, e.ref.logIndex, e.account, e.keyId, e.qx, e.qy, e.rpIdHash, e.keyKind, e.validator]);
    case "jurisdiction":
      return T(["bytes2", "bool", "bool", "uint8", "string", "string", "string", "string"],
        [countryToBytes2(e.country), e.enabled, e.domestic, e.purposeMask, e.name, e.scheme, e.registryName, e.note]);
    case "policy":
      return T(["bool", "bool", "address"], [e.individualTransfer, e.individualRetire, e.treasury]);
    case "fees":
      return T(["bytes2", "uint256", "uint256"], [countryToBytes2(e.country), e.tradeBps, e.retireFeePerTonne]);
    case "identity":
      return T(["address", "uint8", "uint64", "bytes2", "bytes32", "uint256", "uint256"],
        [e.account, e.tier, e.expiry, countryToBytes2(e.jurisdiction), e.identityHash, e.nonce, e.deadline]);
    case "freeze":
      return T(["uint8", "address", "uint256", "bool", "string"], [e.target, e.account, e.batchId, e.frozen, e.reason]);
    case "project":
      return T(["address", "string", "string", "string", "string", "uint256"], [e.account, e.name, e.methodology, e.location, e.metadataURI, e.nonce]);
    case "importProject":
      return T(["address", "bytes2", "string", "string", "string", "string", "string"],
        [e.owner, countryToBytes2(e.country), e.scheme, e.name, e.methodology, e.location, e.metadataURI]);
    case "projectStatus":
      return T(["uint256", "bool"], [e.projectId, e.active]);
    case "issue":
      return T(["uint256", "uint64", "uint64", "uint256", "bytes32", "bytes32", "uint256", "uint256"],
        [e.projectId, e.monitoringStart, e.monitoringEnd, e.amountKg, e.serialHash, e.reportHash, e.attestationId, e.deadline]);
    case "place":
      return T(["address", "uint8", "uint256", "bytes2", "uint256", "uint256", "uint256", "uint64", "uint256"],
        [e.account, e.side === "buy" ? 0 : 1, e.batchId, countryToBytes2(e.country), e.amountKg, e.pricePerTonne, e.minFillKg, e.expiry, e.nonce]);
    case "cancel":
      return T(["address", "uint64", "uint256"], [e.account, e.orderSeq, e.nonce]);
    case "withdraw":
      return T(["address", "uint256", "uint256"], [e.account, e.amount, e.nonce]);
    case "retire":
      return T(["address", "uint256", "uint256", "string", "bytes32", "uint8", "string", "uint256"],
        [e.account, e.batchId, e.amountKg, e.beneficiary, e.beneficiaryHash, e.purpose, e.memo, e.nonce]);
    case "certDocument":
      return T(["uint256", "bytes32"], [e.certId, e.documentHash]);
    case "certOfficial":
      return T(["uint256", "string", "uint64"], [e.certId, e.officialRef, e.officialAt]);
    case "reserveReport":
      return encodeAbiParameters(
        [
          { type: "uint32" }, { type: "uint64" },
          { type: "tuple[]", components: [
            { name: "country", type: "bytes2" }, { name: "custodian", type: "string" }, { name: "accountRef", type: "string" },
            { name: "heldKg", type: "uint256" }, { name: "ledgerKg", type: "uint256" }, { name: "statementHash", type: "bytes32" },
          ] },
          { type: "tuple", components: [
            { name: "trustee", type: "string" }, { name: "accountRef", type: "string" }, { name: "balance", type: "uint256" },
            { name: "tokenSupply", type: "uint256" }, { name: "statementHash", type: "bytes32" },
          ] },
          { type: "bytes32" },
        ],
        [
          e.period, e.asOf,
          e.credits.map((c) => ({ ...c, country: countryToBytes2(c.country) })),
          e.cash, e.documentHash,
        ] as never,
      );
    case "reserveAttest":
      return T(["uint256", "uint8", "string", "string"], [e.reportId, e.status, e.auditorName, e.note]);
  }
}

export const payloadHash = (e: Event): Hex => keccak256(payloadOf(e));

/// 整筆事件的正規化位元組：版本、種類、序號、時間、區塊高度、內容、簽章者、簽章。
/// 簽章也編進去：不編的話，別人可以把同一個內容配上另一個簽章塞進 log，而雜湊不變。
export function encodeEvent(e: Event): Hex {
  const signer = signerOf(e) ?? ZADDR;
  const signature = "signature" in e ? e.signature : "0x";
  return encodeAbiParameters(
    [
      { type: "uint16" }, { type: "uint8" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" },
      { type: "bytes" }, { type: "address" }, { type: "bytes" },
    ],
    [LOG_VERSION, KIND[e.kind], e.seq, e.at, e.atBlock, payloadOf(e), signer, signature as Hex],
  );
}

export const eventHash = (e: Event): Hex => keccak256(encodeEvent(e));

/// 事件級雜湊鏈 h_n = H(h_{n-1} ‖ H(event_n))。簽收收據靠它把位置釘住。
export const chainHash = (prev: Hex, e: Event): Hex =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [prev, eventHash(e)]));

export const GENESIS: Hex = keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint16" }], ["co2x.ledger", LOG_VERSION]));

/// 一期事件的 Merkle root（承諾裡的 `logRoot`），以及單筆事件的包含證據。
///
/// 包含證據是「分層公開」的基礎：公開檔只放登錄簿事件，但每一筆都附上它在 logRoot 裡的證據，
/// 讀者不必看到其他事件（委託單、身分）就能確認這一筆確實在承諾裡。
export function logTree(events: Event[]) {
  const sorted = [...events].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  const t = buildTree(sorted.map((e) => leaf(eventHash(e))));
  return {
    root: t.root,
    proofOf: (seq: bigint): Proof & { index: number } => {
      const i = sorted.findIndex((e) => e.seq === seq);
      if (i < 0) throw new Error(`第 ${seq} 筆不在這一期`);
      return { ...t.proof(i), index: i };
    },
  };
}
export const logLeaf = (e: Event): Hex => leaf(eventHash(e));

// ── JSON 序列化（bigint 以 "123n" 表示）──
export const reviver = (_k: string, v: unknown) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
export const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);
