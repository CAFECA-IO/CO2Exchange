import "server-only";
import path from "node:path";
import { apply, genesis, type State } from "@/lib/ledger/engine";
import { chainHash, eventHash, type Event } from "@/lib/ledger/events";
import { openStore, type Store } from "@/lib/ledger/store";
import { deployment } from "../chain";
import { DATA_DIR } from "../fingerprint";

/// 帳本檢視：網站讀取面的唯一來源（設計 v4：行情、登錄簿、持有都不從鏈上讀）。
///
/// ## 簽章在這裡不重驗
///
/// 每一筆事件在**收單時**已經驗過簽章與授權（沒過的根本不會進帳本）。這裡的檢視只是營運方自己的畫面，
/// 每一次請求都重驗整份帳本的簽章既慢又沒有意義。**重驗是查核者的事**：`npm run ledger:verify`
/// 從鏈上讀授權清單、在收單時的區塊高度重驗每一筆，算出的 anchor 必須等於鏈上那一個。
/// 引擎本身的規則（身分、轄區、餘額）這裡照樣執行，被規則拒絕的事件不會影響畫面。
///
/// ## 增量套用
///
/// 狀態依帳本的 head 快取；有新事件就只套用新的那幾筆。head 倒退（帳本被重建）就從頭來。

export const LEDGER_DIR = process.env.LEDGER_DIR ?? path.join(DATA_DIR, "ledger");

let store: Store | null = null;
export function ledgerStore(): Store {
  if (!store || store.dir !== LEDGER_DIR) store = openStore(LEDGER_DIR);
  return store;
}

export type View = {
  state: State;
  events: Event[];
  /// 被引擎規則拒絕的事件（seq → 理由）。畫面上的「公告」不該列出它們。
  rejected: Map<string, string>;
  head: { seq: bigint; runningHash: `0x${string}` };
  /// 帳本的「現在」：最後一筆事件的邏輯時間，沒有事件時用牆上時鐘
  asOf: number;
};

let cache: { deploymentKey: string; view: View } | null = null;

export function ledgerView(): View {
  const s = ledgerStore();
  const head = s.head();
  const d = deployment();
  const key = `${d.ledger}|${d.deployedAt ?? ""}`;
  if (cache && cache.deploymentKey === key && cache.view.head.seq === head.seq) return cache.view;

  let state: State | null = null, events: Event[] = [];
  if (cache && cache.deploymentKey === key && head.seq > cache.view.head.seq) {
    const fresh = s.read(cache.view.head.seq + 1n);
    // 接得上才增量：新事件從快取的雜湊鏈尾端接下去，要剛好得到現在的 head。
    // 接不上代表帳本被重建過（序號碰巧更大），那就從頭來。
    let running = cache.view.head.runningHash;
    for (const e of fresh) running = chainHash(running, e);
    if (running === head.runningHash) {
      state = cache.view.state;
      events = [...cache.view.events, ...fresh];
      apply(state, fresh, { sigOk: () => true });
    }
  }
  if (!state) {
    events = s.read();
    state = apply(genesis(), events, { sigOk: () => true });
  }
  const rejected = new Map(state.rejected.map((r) => [String(r.seq), r.reason]));
  const last = events[events.length - 1];
  const view: View = { state, events, rejected, head: { seq: head.seq, runningHash: head.runningHash }, asOf: last ? Number(last.at) : Math.floor(Date.now() / 1000) };
  cache = { deploymentKey: key, view };
  return view;
}

/// 從帳本檢視推導出來的東西（公告欄、行情、各國統計……），依帳本的 head 快取。
///
/// 這些都是「整份帳本掃一遍」的計算，原本每個請求都重算一次：公告欄一千多筆事件時一次兩百毫秒，
/// 而且隨帳本線性變慢。帳本沒有新事件，結果就不會變——所以 head 沒動就直接回上一次的結果，
/// head 一動整批作廢（只留目前這一個 head 的結果，記憶體不會越積越多）。
let derived: { key: string; values: Map<string, unknown> } | null = null;
export function memoView<T>(name: string, fn: (v: View) => T): T {
  const v = ledgerView();
  const d = deployment();
  const key = `${d.ledger}|${d.deployedAt ?? ""}|${v.head.seq}|${v.head.runningHash}`;
  if (!derived || derived.key !== key) derived = { key, values: new Map() };
  if (derived.values.has(name)) return derived.values.get(name) as T;
  const out = fn(v);
  derived.values.set(name, out);
  return out;
}

/// 事件雜湊（公告欄、行情的「交易」欄）。事件內容不會變，算一次就記在事件物件上
///（WeakMap：帳本重建、舊的事件物件被丟掉時跟著回收）。
const hashMemo = new WeakMap<Event, string>();
export function eventHashCached(e: Event): string {
  let h = hashMemo.get(e);
  if (!h) { h = eventHash(e); hashMemo.set(e, h); }
  return h;
}
