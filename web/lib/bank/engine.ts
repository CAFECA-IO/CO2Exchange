import type { Address } from "viem";
import type { Event } from "./log";
import type { AccountBalance } from "./tree";

/// 撮合引擎。**純函式**：同一串事件，任何人跑都得出同一組成交與同一份餘額。
///
/// ## 「可重播」是一組實作約束，不是一句形容詞
///
/// 餘額樹的 root 每 24 小時上鏈。要讓「監理方重跑一次就驗得出來」成立，
/// 這支引擎必須對同樣的輸入給出位元組等同的輸出。所以：
///
///   1. **不讀時鐘。** 時間只能來自事件的 `at` 欄位。這裡沒有 `Date.now()`，
///      而且不該有——訂單過不過期，要由「處理到這一筆事件時的邏輯時間」決定。
///      讀牆上時鐘的話，同一串事件在不同時候重播會得出不同結果。
///   2. **不用亂數。**
///   3. **不依賴 Map / 物件的迭代順序。** 所有集合在使用前明確排序。
///      JS 的 Map 保留插入順序，看起來很穩定——但插入順序取決於事件到達順序，
///      而重播時的資料結構未必以同樣順序被填入。靠它就是在賭。
///   4. **整數運算。** 價格與數量都是最小單位的整數。浮點誤差會直接讓 root 對不上，
///      而那看起來會像詐欺，不像四捨五入。
///   5. **規則版本化。** 見 `RULES_VERSION`：規則改版是新版本，舊批次永遠以當時的
///      版本重播。沒有這一條，改一次撮合規則就讓所有歷史無法驗證。
///
/// ## 撮合規則（v1）
///
/// 價格優先、序號其次。賣單依價格由低到高，買單由高到低；同價依 `seq` 由小到大
/// （先到先得）。新單進來時與簿子另一側能成交的部分立刻成交，剩下的掛著。
///
/// 自然人不可轉售的政策**不在這裡**：那是身分層的規則，而身分狀態在鏈上。
/// 引擎只做撮合，把政策塞進來會讓兩個地方各寫一套，遲早不一致——
/// 這正是 `CarbonCredit1155._update` 那段註解講過的同一件事。
/// B 期的政策檢查在下單入口（見 lib/server/bank/orders.ts），而它的判斷依據
/// 會以 `config` / 身分事件的形式進 log，讓重播也看得到。

export const RULES_VERSION = 1;

export type Order = {
  seq: bigint;
  account: Address;
  side: "buy" | "sell";
  batchId: bigint; // 賣單用
  country: string; // 買單用
  remainingKg: bigint;
  pricePerTonne: bigint;
  minFillKg: bigint;
  expiry: bigint;
};

export type Fill = {
  /// 這筆成交是處理哪一個事件時產生的。重播對照用。
  atSeq: bigint;
  at: bigint;
  buyer: Address;
  seller: Address;
  batchId: bigint;
  amountKg: bigint;
  pricePerTonne: bigint;
  cost: bigint; // 買方付出的結算幣（不含手續費）
  fee: bigint; // 從賣方應收裡扣
};

export type State = {
  /// account → batchId → kg
  credits: Map<string, Map<string, bigint>>;
  /// account → 可動用的結算幣
  cash: Map<string, bigint>;
  /// 掛單中的委託。key = seq
  book: Map<string, Order>;
  /// 掛賣單時鎖住的額度、掛買單時鎖住的現金。撤單或成交時釋放。
  lockedCredits: Map<string, Map<string, bigint>>;
  lockedCash: Map<string, bigint>;
  fills: Fill[];
  feeBps: bigint;
  /// 手續費收入（進國庫）。餘額樹要算得進去，否則總額對不上池子。
  treasuryCash: bigint;
  /// 每個帳戶用過的最大 nonce，防重放。
  nonces: Map<string, bigint>;
  /// 被拒絕的事件。**不是錯誤**：重播時它們必須以同樣的理由被拒絕，
  /// 所以理由也要是決定性的。
  rejected: { seq: bigint; reason: string }[];
};

const KG_PER_TONNE = 1000n;

const lower = (a: Address) => a.toLowerCase();
const get2 = (m: Map<string, Map<string, bigint>>, a: string, b: string) => m.get(a)?.get(b) ?? 0n;
function add2(m: Map<string, Map<string, bigint>>, a: string, b: string, v: bigint) {
  const inner = m.get(a) ?? m.set(a, new Map()).get(a)!;
  inner.set(b, (inner.get(b) ?? 0n) + v);
}
const add1 = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);

export function emptyState(feeBps = 0n): State {
  return {
    credits: new Map(), cash: new Map(), book: new Map(),
    lockedCredits: new Map(), lockedCash: new Map(),
    fills: [], feeBps, treasuryCash: 0n, nonces: new Map(), rejected: [],
  };
}

/// 一次跑完一串事件。呼叫端不應該在中途看狀態——這是一個純轉換。
export function apply(state: State, events: Event[]): State {
  for (const e of events) step(state, e);
  return state;
}

function reject(s: State, e: Event, reason: string) {
  s.rejected.push({ seq: e.seq, reason });
}

function step(s: State, e: Event): void {
  switch (e.kind) {
    case "deposit":
      add2(s.credits, lower(e.account), String(e.batchId), e.amountKg);
      return;
    case "cashDeposit":
      add1(s.cash, lower(e.account), e.amount);
      return;
    case "retire":
    case "withdraw": {
      const a = lower(e.account);
      if (get2(s.credits, a, String(e.batchId)) < e.amountKg) return reject(s, e, "餘額不足");
      add2(s.credits, a, String(e.batchId), -e.amountKg);
      return;
    }
    case "cashWithdraw": {
      const a = lower(e.account);
      if ((s.cash.get(a) ?? 0n) < e.amount) return reject(s, e, "餘額不足");
      add1(s.cash, a, -e.amount);
      return;
    }
    case "config":
      s.feeBps = e.feeBps;
      return;
    case "cancel":
      return doCancel(s, e);
    case "place":
      return doPlace(s, e);
  }
}

/// nonce 必須嚴格遞增。重播時同一筆事件會被同樣地拒絕，所以這個檢查也是決定性的。
function checkNonce(s: State, account: Address, nonce: bigint): boolean {
  const a = lower(account);
  if (nonce <= (s.nonces.get(a) ?? 0n)) return false;
  s.nonces.set(a, nonce);
  return true;
}

function doCancel(s: State, e: Extract<Event, { kind: "cancel" }>): void {
  if (!checkNonce(s, e.account, e.nonce)) return reject(s, e, "nonce 不遞增");
  const o = s.book.get(String(e.orderSeq));
  if (!o) return reject(s, e, "找不到這張單");
  if (lower(o.account) !== lower(e.account)) return reject(s, e, "不是自己的單");
  release(s, o);
  s.book.delete(String(e.orderSeq));
}

/// 撤單或成交完時，把當初鎖住的東西放回可動用餘額。
function release(s: State, o: Order): void {
  const a = lower(o.account);
  if (o.side === "sell") {
    add2(s.lockedCredits, a, String(o.batchId), -o.remainingKg);
    add2(s.credits, a, String(o.batchId), o.remainingKg);
  } else {
    const locked = notional(o.remainingKg, o.pricePerTonne);
    add1(s.lockedCash, a, -locked);
    add1(s.cash, a, locked);
  }
}

/// 名目金額：公斤 × 每噸單價 ÷ 1000。整數除法，**無條件捨去**。
/// 捨去的方向要固定且寫下來——兩份實作在這裡不一致，餘額就會差幾個最小單位，
/// 而那足以讓 root 對不上。
export const notional = (kg: bigint, pricePerTonne: bigint): bigint => (kg * pricePerTonne) / KG_PER_TONNE;

function doPlace(s: State, e: Extract<Event, { kind: "place" }>): void {
  if (!checkNonce(s, e.account, e.nonce)) return reject(s, e, "nonce 不遞增");
  if (e.amountKg <= 0n || e.pricePerTonne <= 0n) return reject(s, e, "數量與價格要大於零");
  if (e.expiry <= e.at) return reject(s, e, "有效期限已過");

  const a = lower(e.account);
  // 先鎖住。鎖不住就拒絕——這一步取代了鏈上的託管，而且是餘額樹能對得上的前提。
  if (e.side === "sell") {
    if (get2(s.credits, a, String(e.batchId)) < e.amountKg) return reject(s, e, "碳權餘額不足");
    add2(s.credits, a, String(e.batchId), -e.amountKg);
    add2(s.lockedCredits, a, String(e.batchId), e.amountKg);
  } else {
    const need = notional(e.amountKg, e.pricePerTonne);
    if ((s.cash.get(a) ?? 0n) < need) return reject(s, e, "結算幣餘額不足");
    add1(s.cash, a, -need);
    add1(s.lockedCash, a, need);
  }

  const order: Order = {
    seq: e.seq, account: e.account, side: e.side, batchId: e.batchId, country: e.country,
    remainingKg: e.amountKg, pricePerTonne: e.pricePerTonne, minFillKg: e.minFillKg, expiry: e.expiry,
  };
  match(s, order, e.at, e.seq);
  if (order.remainingKg > 0n) s.book.set(String(order.seq), order);
}

/// 對手方候選：明確排序，不依賴 Map 的迭代順序。
function candidates(s: State, taker: Order, now: bigint): Order[] {
  const want = taker.side === "buy" ? "sell" : "buy";
  const out: Order[] = [];
  for (const o of s.book.values()) {
    if (o.side !== want) continue;
    if (o.expiry <= now) continue; // 過期的單不撮合（清理留給下面）
    if (lower(o.account) === lower(taker.account)) continue; // 不自成交
    // 賣單綁批次，買單綁轄區。兩邊都要對得上才是同一個市場。
    if (want === "sell" ? o.batchId !== taker.batchId : taker.batchId !== o.batchId) {
      // 買單的 batchId 為 0 代表「這個轄區的任何批次」——由下單入口保證 country 相符
      if (!(taker.side === "buy" && taker.batchId === 0n) && !(want === "buy" && o.batchId === 0n)) continue;
    }
    if (taker.side === "buy" ? o.pricePerTonne > taker.pricePerTonne : o.pricePerTonne < taker.pricePerTonne) continue;
    out.push(o);
  }
  // 價格優先、序號其次。這個順序是撮合規則的一部分，不是實作細節。
  out.sort((x, y) => {
    if (x.pricePerTonne !== y.pricePerTonne) {
      return want === "sell"
        ? (x.pricePerTonne < y.pricePerTonne ? -1 : 1) // 買方要最便宜的賣單
        : (x.pricePerTonne > y.pricePerTonne ? -1 : 1); // 賣方要最貴的買單
    }
    return x.seq < y.seq ? -1 : x.seq > y.seq ? 1 : 0;
  });
  return out;
}

function match(s: State, taker: Order, now: bigint, atSeq: bigint): void {
  for (const maker of candidates(s, taker, now)) {
    if (taker.remainingKg === 0n) break;
    let amount = taker.remainingKg < maker.remainingKg ? taker.remainingKg : maker.remainingKg;
    // minFill：吃不到對方的最小成交量就整張跳過（不是部分成交）
    if (amount < maker.minFillKg && amount !== maker.remainingKg) continue;
    if (amount < taker.minFillKg && amount !== taker.remainingKg) continue;
    if (amount <= 0n) continue;

    // 成交價以**掛在簿子上的那一張**為準（maker price）。這是慣例，也是
    // 「先掛單的人拿到自己報的價」這件事在規則上的表現。
    const price = maker.pricePerTonne;
    const buy = taker.side === "buy" ? taker : maker;
    const sell = taker.side === "buy" ? maker : taker;
    const cost = notional(amount, price);
    const fee = (cost * s.feeBps) / 10_000n;

    const b = lower(buy.account);
    const se = lower(sell.account);

    // 買方的錢從鎖定裡出。買單掛的價可能高於成交價，差額退回可動用餘額。
    const lockedForThis = notional(amount, buy.pricePerTonne);
    add1(s.lockedCash, b, -lockedForThis);
    if (lockedForThis > cost) add1(s.cash, b, lockedForThis - cost);

    // 賣方的貨從鎖定裡出
    add2(s.lockedCredits, se, String(sell.batchId), -amount);

    // 交割：貨給買方、錢給賣方（扣手續費）
    add2(s.credits, b, String(sell.batchId), amount);
    add1(s.cash, se, cost - fee);
    s.treasuryCash += fee;

    taker.remainingKg -= amount;
    maker.remainingKg -= amount;
    if (maker.remainingKg === 0n) s.book.delete(String(maker.seq));

    s.fills.push({
      atSeq, at: now, buyer: buy.account, seller: sell.account,
      batchId: sell.batchId, amountKg: amount, pricePerTonne: price, cost, fee,
    });
    amount = 0n;
  }
}

/// 引擎狀態 → 餘額樹的輸入。
///
/// **鎖住的東西也算你的。** 掛在簿子上的額度與現金仍然是使用者的資產，
/// 只是不能動——餘額樹要把它算進去，否則樹的總額會小於池子裡實際持有，
/// 看起來像交易所多收了錢。
export function toBalances(s: State, treasury?: Address): AccountBalance[] {
  const accounts = new Set<string>([
    ...s.credits.keys(), ...s.cash.keys(), ...s.lockedCredits.keys(), ...s.lockedCash.keys(),
  ]);
  const out: AccountBalance[] = [];
  for (const a of [...accounts].sort()) {
    const assets = new Map<string, bigint>();
    for (const [batch, kg] of s.credits.get(a) ?? []) if (kg > 0n) assets.set(batch, (assets.get(batch) ?? 0n) + kg);
    for (const [batch, kg] of s.lockedCredits.get(a) ?? []) if (kg > 0n) assets.set(batch, (assets.get(batch) ?? 0n) + kg);
    const cash = (s.cash.get(a) ?? 0n) + (s.lockedCash.get(a) ?? 0n);
    if (assets.size === 0 && cash === 0n) continue;
    out.push({
      account: a as Address,
      assets: [...assets.entries()]
        .map(([batchId, kg]) => ({ batchId: BigInt(batchId), kg }))
        .sort((x, y) => (x.batchId < y.batchId ? -1 : 1)),
      cash,
    });
  }
  if (treasury && s.treasuryCash > 0n) {
    const t = lower(treasury);
    const existing = out.find((b) => b.account.toLowerCase() === t);
    if (existing) existing.cash += s.treasuryCash;
    else out.push({ account: treasury, assets: [], cash: s.treasuryCash });
  }
  return out;
}
