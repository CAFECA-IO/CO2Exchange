import "server-only";
import fs from "node:fs";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { chainHash, eventHash, GENESIS, receiptDigest, type Event, type Receipt } from "@/lib/bank/log";
import { IS_LOCAL_CHAIN, requireOwnKey } from "../chain";
import { ApiError } from "../api";

/// 委託單 log 的存放：**只追加，不修改**。
///
/// Phase 0 放本機 JSONL（一行一筆事件）。正式環境會是資料庫或 WORM 儲存，
/// 但形狀不會變：一條嚴格遞增的序號、一條接起來的雜湊鏈、以及每一筆的簽收收據。
///
/// 為什麼是 JSONL 而不是一個大 JSON：追加要是 O(1) 而且**中途當掉不會毀掉整份檔**。
/// 一個大 JSON 每次都要整份重寫，寫到一半斷電就什麼都不剩了——而這份檔案是
/// 使用者主張「我下過這張單」的唯一依據。
///
/// 序號與雜湊鏈由這一層維護，不由呼叫端傳入：呼叫端能決定序號的話，
/// 「全序」就只是一個欄位名稱而已。

const DIR = process.env.ORDERLOG_DIR ?? path.resolve(process.cwd(), "data", "orderlog");
const EVENTS = path.join(DIR, "events.jsonl");
const HEAD = path.join(DIR, "head.json");

type HeadDoc = { seq: string; runningHash: Hex; updatedAt: string };

/// 交易所的簽收金鑰。用 relayer 那把（Phase 0 三合一），
/// 但獨立一個名字，因為它簽的是**對使用者的承諾**，不是交易——
/// 正式環境這把要分開，而且要能單獨輪替。
function receiptSigner() {
  const pk = process.env.RECEIPT_SIGNER_PK ?? process.env.RELAYER_PK;
  return privateKeyToAccount(requireOwnKey("RECEIPT_SIGNER_PK", pk) as Hex);
}

const reviver = (_k: string, v: unknown) =>
  typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);

function readHead(): HeadDoc {
  try {
    return JSON.parse(fs.readFileSync(HEAD, "utf8")) as HeadDoc;
  } catch {
    return { seq: "0", runningHash: GENESIS, updatedAt: new Date(0).toISOString() };
  }
}

export function head(): { seq: bigint; runningHash: Hex } {
  const h = readHead();
  return { seq: BigInt(h.seq), runningHash: h.runningHash };
}

export function readEvents(opts?: { fromSeq?: bigint; toSeq?: bigint }): Event[] {
  let raw: string;
  try { raw = fs.readFileSync(EVENTS, "utf8"); } catch { return []; }
  const out: Event[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line, reviver) as Event;
    if (opts?.fromSeq !== undefined && e.seq < opts.fromSeq) continue;
    if (opts?.toSeq !== undefined && e.seq > opts.toSeq) continue;
    out.push(e);
  }
  // 讀進來就排序。檔案本來就是照順序寫的，但重播的正確性不該建立在
  // 「檔案沒被人動過」這個假設上——排序一次很便宜，錯一次很貴。
  return out.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
}

/// 追加一筆事件，回傳簽收收據。
///
/// 收據裡的 `runningHash` 把這筆事件釘在鏈上的某一個位置。之後這個序號沒有
/// 出現在任何批次裡，使用者手上這張交易所簽名的收據就是違約證據。
/// `Omit` 對聯集型別會塌成共同欄位（只剩 kind），所以要分配式的版本——
/// 不然這裡收到的參數型別會弱到 `account` 都不認得。
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewEvent = DistOmit<Event, "seq" | "at"> & { at?: bigint };

export async function append(partial: NewEvent): Promise<{ event: Event; receipt: Receipt }> {
  fs.mkdirSync(DIR, { recursive: true });
  const h = head();
  const seq = h.seq + 1n;
  const at = partial.at ?? BigInt(Math.floor(Date.now() / 1000));
  const event = { ...partial, seq, at } as Event;

  const eh = eventHash(event);
  const runningHash = chainHash(h.runningHash, event);

  // 先寫事件，再更新 head。順序反過來的話，中途當掉會留下一個
  // 「head 說有第 N 筆，但檔案裡沒有」的狀態——那比少一筆更難處理。
  fs.appendFileSync(EVENTS, `${JSON.stringify(event, replacer)}\n`);
  fs.writeFileSync(
    HEAD,
    JSON.stringify({ seq: String(seq), runningHash, updatedAt: new Date().toISOString() } satisfies HeadDoc, null, 2),
  );

  const signer = receiptSigner();
  const body = { seq, eventHash: eh, prevRunningHash: h.runningHash, runningHash, receivedAt: at };
  const signature = await signer.signMessage({ message: { raw: receiptDigest(body) } });
  return { event, receipt: { ...body, signature, signer: signer.address as Address } };
}

/// 這個帳戶下一個該用的 nonce。
export function nextNonce(account: Address): bigint {
  const a = account.toLowerCase();
  let max = 0n;
  for (const e of readEvents()) {
    if ((e.kind === "place" || e.kind === "cancel") && e.account.toLowerCase() === a && e.nonce > max) max = e.nonce;
  }
  return max + 1n;
}

/// 開發用：清空 log。**只在本機鏈允許**——正式環境上「清空 log」這個動作
/// 本身就不該存在，它等於把所有人的證據一起丟掉。
export function reset(): void {
  if (!IS_LOCAL_CHAIN) throw new ApiError("FORBIDDEN", "只有本機測試鏈可以清空委託單 log");
  fs.rmSync(DIR, { recursive: true, force: true });
}
