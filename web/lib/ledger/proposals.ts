import fs from "node:fs";
import path from "node:path";
import { concat, hashTypedData, keccak256, recoverAddress, toBytes, type Address, type Hex } from "viem";
import { activeKeys, isAuthorized, roleFor, thresholdAt, type Authorities, type Role } from "./authorities.ts";
import { replacer, reviver, type Event, type Kind } from "./events.ts";
import type { NewEvent, Receipt, ReceiptSigner, Store } from "./store.ts";
import { authTypedData, type Domains } from "./typed.ts";

/// k-of-n 授權事件的提案（簽章模型方案 B：主權、營運、查核角色）。
///
/// 流程：任何人建立提案（事件內容）→ 持有人各自用自己的錢包簽同一則 `LedgerEvent`
/// （EIP-712，硬體錢包都支援）→ 收滿門檻 k 個之後寫進帳本。簽章接在一起放進事件的 `signature` 欄位，
/// 查核時逐一 ecrecover，不需要讀任何合約狀態。
///
/// 簽章只涵蓋事件內容（`version, kind, payloadHash`），不涵蓋收單區塊——所以收簽章可以花幾天，
/// 最後寫進帳本時才決定 `atBlock`，並在那一塊檢查每一位簽章者當時仍有授權、數量仍達門檻。
///
/// 提案存成 `<LEDGER_DIR>/proposals/<id>.json`。網站（建立、列出）與 CLI（簽署、送出）共用同一個目錄。
/// 不依賴 Next。

export type Proposal = {
  id: string;
  kind: Kind;
  role: Role;
  /// 事件內容（不含 seq、at、atBlock、signer、signature）
  body: Record<string, unknown>;
  digest: Hex;
  createdAt: string;
  createdBy: string;
  note: string;
  signatures: { signer: Address; signature: Hex; at: string }[];
  status: "open" | "submitted" | "cancelled";
  seq?: string;
};

const dirOf = (ledgerDir: string) => path.join(ledgerDir, "proposals");
const fileOf = (ledgerDir: string, id: string) => {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error("提案編號格式不對");
  return path.join(dirOf(ledgerDir), `${id}.json`);
};
const save = (ledgerDir: string, p: Proposal) => {
  fs.mkdirSync(dirOf(ledgerDir), { recursive: true });
  const f = fileOf(ledgerDir, p.id);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(p, replacer, 2));
  fs.renameSync(`${f}.tmp`, f);
};

export function readProposal(ledgerDir: string, id: string): Proposal {
  try { return JSON.parse(fs.readFileSync(fileOf(ledgerDir, id), "utf8"), reviver) as Proposal; }
  catch { throw new Error(`找不到提案 ${id}`); }
}

export function listProposals(ledgerDir: string): Proposal[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dirOf(ledgerDir)).filter((n) => /^[0-9a-f]{16}\.json$/.test(n)); } catch { return []; }
  return names.map((n) => readProposal(ledgerDir, n.slice(0, 16))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/// 事件草稿：簽章只涵蓋內容，seq／at／atBlock 在這裡填 0，不影響 digest。
function draftOf(p: { kind: Kind; body: Record<string, unknown> }, signer: Address = "0x0000000000000000000000000000000000000000"): Event {
  return { seq: 0n, at: 0n, atBlock: 0n, kind: p.kind, ...p.body, signer, signature: "0x" } as unknown as Event;
}

/// 給持有人的錢包簽的那一包（EIP-712）。
export const typedDataOf = (domains: Domains, p: { kind: Kind; body: Record<string, unknown> }) => authTypedData(domains, draftOf(p));

export function createProposal(ledgerDir: string, domains: Domains, a: { kind: Kind; body: Record<string, unknown>; createdBy: string; note?: string }): Proposal {
  const role = roleFor(draftOf(a));
  if (!role) throw new Error(`${a.kind} 不是授權事件`);
  const digest = hashTypedData(typedDataOf(domains, a));
  const createdAt = new Date().toISOString();
  const id = keccak256(toBytes(`${digest}|${createdAt}|${Math.random()}`)).slice(2, 18);
  const p: Proposal = { id, kind: a.kind, role, body: a.body, digest, createdAt, createdBy: a.createdBy, note: a.note ?? "", signatures: [], status: "open" };
  save(ledgerDir, p);
  return p;
}

/// 加一個簽章。簽章者要在**現在**有這個角色（寫進帳本時會在收單區塊再檢查一次）。
export async function addSignature(ledgerDir: string, id: string, signature: Hex, authorities: Authorities, atBlock: bigint): Promise<Proposal> {
  const p = readProposal(ledgerDir, id);
  if (p.status !== "open") throw new Error(`提案 ${id} 已經${p.status === "submitted" ? "寫進帳本" : "取消"}`);
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("簽章要是 65 bytes 的 ECDSA 簽章");
  const signer = await recoverAddress({ hash: p.digest, signature });
  if (!isAuthorized(authorities, p.role, signer, atBlock)) throw new Error(`${signer} 目前沒有 ${p.role} 授權`);
  if (p.signatures.some((s) => s.signer.toLowerCase() === signer.toLowerCase())) throw new Error(`${signer} 已經簽過`);
  p.signatures.push({ signer, signature, at: new Date().toISOString() });
  save(ledgerDir, p);
  return p;
}

export function cancelProposal(ledgerDir: string, id: string): Proposal {
  const p = readProposal(ledgerDir, id);
  if (p.status !== "open") throw new Error(`提案 ${id} 不是進行中`);
  p.status = "cancelled";
  save(ledgerDir, p);
  return p;
}

/// 進度：現在的門檻、已收的有效簽章、還可以簽的人。
export function progressOf(p: Proposal, authorities: Authorities, atBlock: bigint) {
  const required = thresholdAt(authorities, p.role, atBlock);
  const valid = p.signatures.filter((s) => isAuthorized(authorities, p.role, s.signer, atBlock));
  const signed = new Set(valid.map((s) => s.signer.toLowerCase()));
  return { required, collected: valid.length, pending: activeKeys(authorities, p.role, atBlock).filter((a) => !signed.has(a.toLowerCase())) };
}

/// 收滿門檻就寫進帳本。每一位簽章者在 `atBlock` 都要仍有授權。
export async function submitProposal(ledgerDir: string, id: string, a: {
  store: Store; authorities: Authorities; atBlock: bigint; receiptSigner?: ReceiptSigner;
}): Promise<{ proposal: Proposal; event: Event; receipt: Receipt | null }> {
  const p = readProposal(ledgerDir, id);
  if (p.status !== "open") throw new Error(`提案 ${id} 不是進行中`);
  const { required } = progressOf(p, a.authorities, a.atBlock);
  const valid = p.signatures.filter((s) => isAuthorized(a.authorities, p.role, s.signer, a.atBlock)).slice(0, Math.max(required, 1));
  if (valid.length < required) throw new Error(`${p.role} 需要 ${required} 個簽章，目前有效的只有 ${valid.length} 個`);
  const draft = draftOf(p, valid[0].signer);
  const { seq: _s, at: _a, ...rest } = { ...draft, atBlock: a.atBlock, signature: concat(valid.map((s) => s.signature)) } as Event;
  void _s; void _a;
  const { event, receipt } = await a.store.append(rest as NewEvent, { receiptSigner: a.receiptSigner });
  p.status = "submitted";
  p.seq = String(event.seq);
  save(ledgerDir, p);
  return { proposal: p, event, receipt };
}
