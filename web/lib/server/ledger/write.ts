import "server-only";
import { createWalletClient, http, parseAbi, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { auth } from "@/auth";
import { authTypedData, userDigest, userMessageOf, userTypedData, type Domains } from "@/lib/ledger/typed";
import { isAuthorized, roleFor, type Authorities, type Role } from "@/lib/ledger/authorities";
import { readAuthorities } from "@/lib/ledger/chain";
import { onchainVerifier } from "@/lib/ledger/replay";
import { mirrorCash } from "@/lib/ledger/mirror";
import type { Event, EventOf, Kind } from "@/lib/ledger/events";
import type { NewEvent, Receipt } from "@/lib/ledger/store";
import { IS_LOCAL_CHAIN, RPC_URL, chain, deployment, documentSigner, identityVerifier, publicClient, relayerClient, requireOwnKey } from "../chain";
import { submit } from "../tx";
import { ApiError } from "../api";
import { devKeyOf } from "../dev-key";
import { ledgerStore, ledgerView } from "./view";

/// 帳本的寫入面（設計 v4 第 3 期）：網站上所有會改變登錄簿、身分、市場狀態的動作，
/// 都在這裡變成一筆**簽過章、記了收單區塊高度**的帳本事件。
///
/// 兩種事件，兩種驗法：
///
///   · **授權事件**（身分、核發、憑證回寫…）由本站持有的服務金鑰簽。送出前先確認那把金鑰
///     **此刻**在鏈上的授權清單裡有對應的角色——沒有的話寫進去也會在重播時被拒絕，
///     而重播被拒絕的事件不會有人注意到，直到查核那天。
///   · **使用者事件**（掛單、撤單、註銷、登錄專案）由使用者的 CAFECA 帳戶簽。收單時在
///     **現在的區塊高度**驗 ERC-1271（或 ecrecover），驗過才寫，並把那個高度記進事件。
///     查核者之後用 archive 節點在同一個高度重驗——金鑰換過也驗得回去。
///
/// 收單之後回一張簽收收據（RECEIPT_SIGNER）。收據上的序號沒有出現在任何一期承諾裡，
/// 就是交易所違約的證據。

export function domains(): Domains {
  const d = deployment();
  if (!d.ledger) throw new ApiError("DEPLOYMENT_MISMATCH", "部署檔裡沒有帳本合約（ledger）");
  return { chainId: d.chainId, ledger: d.ledger };
}

// ── 服務金鑰 ──

/// 收單金鑰：簽收收據。Phase 0 沿用 relayer（和 v1 一樣），正式環境要分開、可單獨輪替。
const receiptSigner = privateKeyToAccount(
  requireOwnKey("RECEIPT_SIGNER_PK", process.env.RECEIPT_SIGNER_PK ?? process.env.RELAYER_PK) as Hex,
);

let carbonVerifierAccount: PrivateKeyAccount | null = null;
let operatorAccount: PrivateKeyAccount | null = null;

/// 每個角色用哪一把金鑰簽。**主權與查核機構不在這裡**：前者是國家 Safe，後者是外部機構，
/// 本站不應持有它們的金鑰（本機展示由 ledger-seed 代簽）。
function signerFor(role: Role): PrivateKeyAccount {
  switch (role) {
    case "IDENTITY_VERIFIER":
      return identityVerifier;
    case "CARBON_VERIFIER":
      return (carbonVerifierAccount ??= privateKeyToAccount(
        requireOwnKey("CARBON_VERIFIER_PK", process.env.CARBON_VERIFIER_PK ?? process.env.RELAYER_PK) as Hex,
      ));
    case "DOCUMENT_SIGNER":
      return documentSigner;
    case "OPERATOR":
      return (operatorAccount ??= privateKeyToAccount(
        requireOwnKey("OPERATOR_SIGNER_PK", process.env.OPERATOR_SIGNER_PK ?? process.env.RELAYER_PK) as Hex,
      ));
    default:
      throw new ApiError("FORBIDDEN", `本站不持有 ${role} 角色的金鑰——這類事件要由該角色自己簽`);
  }
}

// ── 鏈上授權清單（快取一分鐘；授權變動要走 Timelock，一分鐘的延遲無關緊要） ──

/// 快取的鍵要含部署時間：本機鏈重開之後，新部署常常落在**同一個位址**上，
/// 只用位址當鍵會拿舊鏈的授權歷史去判斷新鏈的區塊高度。
let authCache: { key: string; at: number; value: Authorities } | null = null;
async function authorities(): Promise<Authorities> {
  const d = deployment();
  const key = `${d.ledger}|${d.deployedAt ?? ""}`;
  if (authCache && authCache.key === key && Date.now() - authCache.at < 60_000) return authCache.value;
  const value = await readAuthorities(publicClient, d.ledger!, { fromBlock: BigInt(d.deployedAtBlock ?? 0) });
  authCache = { key, at: Date.now(), value };
  return value;
}

export type Appended = { event: Event; receipt: Receipt | null; rejectedReason: string | null };

/// 寫進帳本之後，引擎怎麼看這一筆。被規則拒絕的事件**仍然在帳本裡**（帳本記輸入，不記結果），
/// 只是不改變任何狀態——回給呼叫端的是理由，讓畫面說得出為什麼。
function outcome(event: Event, receipt: Receipt | null): Appended {
  const v = ledgerView();
  return { event, receipt, rejectedReason: v.rejected.get(String(event.seq)) ?? null };
}

type AuthBody<K extends Kind> = Omit<EventOf<K>, "seq" | "at" | "atBlock" | "kind" | "signer" | "signature">;

/// 以本站的服務金鑰簽一筆授權事件並寫進帳本。
export async function appendAuthority<K extends Kind>(kind: K, body: AuthBody<K>): Promise<Appended> {
  const d = domains();
  const atBlock = await publicClient.getBlockNumber();
  const draft = { seq: 0n, at: 0n, atBlock, kind, ...body, signer: "0x0000000000000000000000000000000000000000", signature: "0x" } as unknown as Event;
  const role = roleFor(draft);
  if (!role) throw new ApiError("INVALID_PARAM", `${kind} 不是授權事件`);
  const signer = signerFor(role);
  if (!isAuthorized(await authorities(), role, signer.address, atBlock)) {
    // 只講地址與角色，不碰金鑰本身
    throw new ApiError("FORBIDDEN", `本站的 ${role} 金鑰（${signer.address}）不在帳本合約的授權清單裡，寫進去也會在重播時被拒絕`);
  }
  (draft as { signer: Address }).signer = signer.address;
  const signature = await signer.signTypedData(authTypedData(d, draft));
  const { seq: _s, at: _a, ...rest } = { ...draft, signature } as Event;
  void _s; void _a;
  const { event, receipt } = await ledgerStore().append(rest as NewEvent, { receiptSigner });
  return outcome(event, receipt);
}

// ── 使用者事件 ──

type UserKind = "place" | "cancel" | "retire" | "project";
export type UserBody<K extends UserKind> = Omit<EventOf<K>, "seq" | "at" | "atBlock" | "kind" | "signature">;

/// 這個帳戶下一個 nonce。四種使用者事件共用一條、嚴格遞增。
export function nextNonce(account: Address): bigint {
  return (ledgerView().state.nonces.get(account.toLowerCase()) ?? 0n) + 1n;
}

/// 使用者要簽的那一包（交給 CAFECA 錢包）。前端不自己組：欄位順序差一個，digest 就不一樣。
export function userMessage<K extends UserKind>(kind: K, body: UserBody<K>) {
  return userMessageOf({ seq: 0n, at: 0n, atBlock: 0n, kind, ...body, signature: "0x" } as unknown as EventOf<UserKind>);
}

/// 驗過使用者的簽章（在現在的區塊高度）後寫進帳本。
export async function appendUser<K extends UserKind>(kind: K, body: UserBody<K>, signature: Hex): Promise<Appended> {
  const d = domains();
  const atBlock = await publicClient.getBlockNumber();
  const digest = userDigest(d, kind, userMessage(kind, body));
  const check = await onchainVerifier(publicClient)({ signer: body.account, digest, signature, atBlock });
  if (!check.ok) throw new ApiError("SIGNATURE_INVALID", `簽章沒有通過驗證：${check.reason ?? "不明原因"}`);
  const want = nextNonce(body.account);
  if (body.nonce < want) throw new ApiError("INVALID_PARAM", `nonce 已經用過（下一個是 ${want}）`, { param: "nonce", next: String(want) });
  const { event, receipt } = await ledgerStore().append({ atBlock, kind, ...body, signature } as unknown as NewEvent, { receiptSigner });
  return outcome(event, receipt);
}

// ── 開發用登入的簽章 ──

/// 開發用登入的帳戶由代號推出一把私鑰（`auth.ts`），所以它**真的**簽得出 EIP-712，
/// 帳本裡的簽章在查核時照樣驗得過——本機展示走的是和正式環境同一條路，只是簽的人是伺服器。
///
/// 只在非 production、本機鏈上才有；以地址登入的開發帳戶沒有私鑰，回 null。
export async function devSignerFor(account: Address): Promise<PrivateKeyAccount | null> {
  if (process.env.NODE_ENV === "production" || !IS_LOCAL_CHAIN) return null;
  const s = await auth();
  const u = s?.user as { name?: string | null; provider?: string } | undefined;
  if (u?.provider !== "dev" || !u.name || u.name.startsWith("0x")) return null;
  const a = privateKeyToAccount(devKeyOf(u.name));
  return a.address.toLowerCase() === account.toLowerCase() ? a : null;
}

/// 開發帳戶代簽：組好同一包 typed data，用推出來的私鑰簽。
export async function devSign<K extends UserKind>(signer: PrivateKeyAccount, kind: K, body: UserBody<K>): Promise<Hex> {
  return signer.signTypedData(userTypedData(domains(), kind, userMessage(kind, body)) as Parameters<PrivateKeyAccount["signTypedData"]>[0]);
}

// ── 結算幣鏡像 ──

export async function syncCash(): Promise<number> {
  const d = deployment();
  const { added } = await mirrorCash({
    store: ledgerStore(), client: publicClient, ledger: d.ledger!, fromBlock: BigInt(d.deployedAtBlock ?? 0), receiptSigner,
  });
  return added.length;
}

/// 開發帳戶的入金（只在本機鏈、結算幣是本站自己發的 MockTWD 時）：
/// 補 gas → 鑄結算幣給他 → **他自己**（推出來的私鑰）approve 並存進帳本合約 → 鏡像進帳本。
///
/// 存入仍然是鏈上真的一筆 `depositCash`，所以查核工具的「鏈上存提與帳本逐筆相符」照樣成立。
export async function devDeposit(signer: PrivateKeyAccount, amount: bigint): Promise<number> {
  const d = deployment();
  if (!IS_LOCAL_CHAIN || d.settlementMintable !== true) throw new ApiError("FORBIDDEN", "只有本機鏈、本站發行的結算幣可以用開發入金");
  if (amount <= 0n || amount > 10_000_000n * 10n ** 6n) throw new ApiError("INVALID_PARAM", "金額要在 0 到一千萬之間", { param: "amount" });
  await fetch(RPC_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [signer.address, "0x8ac7230489e80000"] }),
  });
  const abi = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function depositCash(uint256)"]);
  await submit({ address: d.settlementToken, abi, functionName: "mint", args: [signer.address, amount], account: relayerClient.account!, chain });
  const w = createWalletClient({ chain, account: signer, transport: http(RPC_URL) });
  await submit({ address: d.settlementToken, abi, functionName: "approve", args: [d.ledger!, amount], account: signer, chain }, w);
  await submit({ address: d.ledger!, abi, functionName: "depositCash", args: [amount], account: signer, chain }, w);
  return syncCash();
}

export const receiptSignerAddress = (): Address => receiptSigner.address;
