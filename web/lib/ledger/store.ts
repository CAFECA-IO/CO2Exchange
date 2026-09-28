import fs from "node:fs";
import path from "node:path";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { chainHash, eventHash, GENESIS, replacer, reviver, type Event } from "./events.ts";

/// 帳本 v2 的存放：**只追加，不修改**。一行一筆事件（JSONL）＋一個 head 檔。
///
/// 兩個要點：
///   · **多個行程會同時寫**：網站的收單 API、後台做市、模擬器、管理員的授權事件。
///     所以追加有檔案鎖（mkdir 是原子的），序號與雜湊鏈在鎖裡決定。沒有鎖的話，
///     兩個行程會拿到同一個序號，而重播會在那裡斷掉——那是整份帳本作廢。
///   · 不依賴 Next：常駐程式與查核工具都要能直接用它。
///
/// 序號、邏輯時間、雜湊鏈都由這一層決定，不由呼叫端傳入：呼叫端能決定序號的話，「全序」就只是欄位名稱。

type HeadDoc = { seq: string; runningHash: Hex; lastAt: string; updatedAt: string };
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewEvent = DistOmit<Event, "seq" | "at">;

export type Receipt = {
  seq: bigint; eventHash: Hex; prevRunningHash: Hex; runningHash: Hex; receivedAt: bigint;
  signature: Hex; signer: Address;
};
export const receiptDigest = (r: Omit<Receipt, "signature" | "signer">): Hex =>
  keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }],
    ["co2x.receipt.v2", r.seq, r.eventHash, r.prevRunningHash, r.runningHash, r.receivedAt],
  ));

/// 簽收收據的簽章者。收單金鑰在鏈上的授權清單裡（RECEIPT_SIGNER），使用者拿著收據就能主張
/// 「交易所承認收到了、而且放在第 seq 號」——那個序號沒有出現在任何一期承諾裡，就是違約證據。
export type ReceiptSigner = { address: Address; signMessage: (a: { message: { raw: Hex } }) => Promise<Hex> };

export function openStore(dir: string) {
  const EVENTS = path.join(dir, "events.jsonl");
  const HEAD = path.join(dir, "head.json");
  const LOCK = path.join(dir, ".lock");

  function readHead(): { seq: bigint; runningHash: Hex; lastAt: bigint } {
    try {
      const h = JSON.parse(fs.readFileSync(HEAD, "utf8")) as HeadDoc;
      return { seq: BigInt(h.seq), runningHash: h.runningHash, lastAt: BigInt(h.lastAt ?? "0") };
    } catch {
      return { seq: 0n, runningHash: GENESIS, lastAt: 0n };
    }
  }

  function read(fromSeq = 1n, toSeq?: bigint): Event[] {
    let raw: string;
    try { raw = fs.readFileSync(EVENTS, "utf8"); } catch { return []; }
    const out: Event[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line, reviver) as Event;
      if (e.seq < fromSeq) continue;
      if (toSeq !== undefined && e.seq > toSeq) continue;
      out.push(e);
    }
    return out.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  }

  async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    fs.mkdirSync(dir, { recursive: true });
    const started = Date.now();
    for (;;) {
      try { fs.mkdirSync(LOCK); break; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // 持有鎖的行程當掉的話鎖會留著。30 秒還沒放掉就當作遺留的——追加一筆不可能要那麼久
        try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 30_000) { fs.rmdirSync(LOCK); continue; } } catch { /* 剛好被放掉 */ }
        if (Date.now() - started > 10_000) throw new Error("帳本忙碌中（10 秒內拿不到寫入鎖）");
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
      }
    }
    try { return await fn(); } finally { try { fs.rmdirSync(LOCK); } catch { /* 已經不在了 */ } }
  }

  /// 追加一筆事件。`at` 由這裡給（牆上時鐘，但**不得早於前一筆**——引擎要求時間單調）。
  ///
  /// `skipIf` 在**鎖裡**判斷要不要寫（回 true 就不寫、回傳 null）。鏈上存入的鏡像要靠它去重：
  /// 兩個行程同時看到同一筆鏈上存入，在鎖外各自檢查都會說「還沒記」，於是記兩次——入金變成兩倍。
  async function append(
    partial: NewEvent,
    opts: { receiptSigner?: ReceiptSigner; at?: bigint; skipIf?: () => boolean } = {},
  ): Promise<{ event: Event; receipt: Receipt | null }> {
    const r = await appendIf(partial, opts);
    if (!r) throw new Error("事件被 skipIf 略過");
    return r;
  }

  /// `partial` 也可以是一個函式：在**鎖裡**才決定內容（回 null 就不寫）。使用者事件的 nonce 要在鎖裡定，
  /// 簽章又包含 nonce——所以常駐程式在這裡面簽（見 agent.ts）。簽 EIP-712 是本機運算，不會拖住鎖。
  async function appendIf(
    partial: NewEvent | (() => Promise<NewEvent | null> | NewEvent | null),
    opts: { receiptSigner?: ReceiptSigner; at?: bigint; skipIf?: () => boolean } = {},
  ): Promise<{ event: Event; receipt: Receipt | null } | null> {
    const done = await withLock(async () => {
      if (opts.skipIf?.()) return null;
      const content = typeof partial === "function" ? await partial() : partial;
      if (!content) return null;
      const h = readHead();
      const seq = h.seq + 1n;
      const now = opts.at ?? BigInt(Math.floor(Date.now() / 1000));
      const at = now < h.lastAt ? h.lastAt : now;
      const event = { ...content, seq, at } as Event;
      const runningHash = chainHash(h.runningHash, event);
      // 先寫事件，再更新 head：中途當掉最多留下一筆 head 還不知道的事件，重開時會被偵測到
      fs.appendFileSync(EVENTS, `${JSON.stringify(event, replacer)}\n`);
      const doc: HeadDoc = { seq: String(seq), runningHash, lastAt: String(at), updatedAt: new Date().toISOString() };
      fs.writeFileSync(`${HEAD}.tmp`, JSON.stringify(doc, null, 2));
      fs.renameSync(`${HEAD}.tmp`, HEAD);
      return { event, prev: h.runningHash, runningHash };
    });
    if (!done) return null;
    const { event, prev, runningHash } = done;
    if (!opts.receiptSigner) return { event, receipt: null };
    const body = { seq: event.seq, eventHash: eventHash(event), prevRunningHash: prev, runningHash, receivedAt: event.at };
    const signature = await opts.receiptSigner.signMessage({ message: { raw: receiptDigest(body) } });
    return { event, receipt: { ...body, signature, signer: opts.receiptSigner.address } };
  }

  /// head 與檔案內容對得上嗎？（當掉之後的檢查：事件數、最後序號、雜湊鏈）
  function check(): { ok: boolean; problem?: string } {
    const h = readHead();
    const evs = read();
    if (BigInt(evs.length) !== h.seq) return { ok: false, problem: `head 說有 ${h.seq} 筆，檔案裡有 ${evs.length} 筆` };
    let running = GENESIS;
    for (const [i, e] of evs.entries()) {
      if (e.seq !== BigInt(i + 1)) return { ok: false, problem: `第 ${i + 1} 筆的序號是 ${e.seq}` };
      running = chainHash(running, e);
    }
    if (running !== h.runningHash) return { ok: false, problem: "雜湊鏈與 head 不符" };
    return { ok: true };
  }

  return { dir, head: readHead, read, append, appendIf, check, withLock };
}
export type Store = ReturnType<typeof openStore>;
