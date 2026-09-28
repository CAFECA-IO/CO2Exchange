// 做市策略：純函式，不碰鏈、不讀時鐘、不用亂數——同樣的輸入一定得到同樣的報價，
// 所以可以被單元測試、也可以事後重算「那一刻為什麼掛那個價」。
//
// 單位：價格一律是 bigint、結算幣最小單位 / 噸（與 Listing.pricePerTonne 相同，6 decimals）；
//       數量一律是 Number、公斤（與合約相同）；金額是 bigint 最小單位。
//
// 做市的定義（這支程式的邊界）：
//   · 只**被動報價**：掛買單、掛賣單，等別人來成交。不主動吃任何單。
//   · 絕不與平台控制的帳戶成交（做市帳戶彼此、營運金鑰、模擬人物）——那是製造成交量，不是做市。
//     被動報價擋不住別人來吃，所以另一半的保證在模擬器那一側：它看不見做市帳戶的單。
//   · 買價永遠低於外部最佳賣價、賣價永遠高於外部最佳買價，不製造交叉的簿子。

export const UNIT = 10n ** 6n;           // 1 結算幣
export const TICK = UNIT;                // 報價最小跳動：每噸 1 元
export const BPS = 10_000n;

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  enabled: false,
  capitalTWD: 0,             // 撥給做市帳戶的結算幣上限（整數元）。累計撥款不會超過它。
  maxInventoryTonnes: 500,   // 做市帳戶最多持有多少噸（含掛在簿子上的）
  maxOrderTonnes: 50,        // 單一報價的最大數量
  levels: 3,                 // 每一側幾檔
  spreadBps: 400,            // 最內層買賣價差（總寬度）
  stepBps: 150,              // 每往外一檔再加寬多少
  anchorPricePerTonne: 800,  // 沒有任何成交與報價時的參考價（元／噸）
  floorPerTonne: 300,        // 報價下限
  ceilPerTonne: 2200,        // 報價上限
  maxDailyLossTWD: 20_000,   // 單日（台北時間）權益下跌超過這個數字就停止報價；0 = 不設
  requoteBps: 100,           // 既有報價與目標差超過多少才撤掉重掛（避免每輪都撤單重掛）
  intervalSec: 60,           // 每輪間隔
  minFillTonnes: 1,          // 報價的最小成交量
  simulation: { enabled: false, users: 30, intervalSec: 300 },
  commands: { recall: 0, resume: 0 },
});

const toUnits = (twdPerTonne) => BigInt(Math.round(Number(twdPerTonne))) * UNIT;
const clamp = (p, lo, hi) => (p < lo ? lo : p > hi ? hi : p);
const floorTick = (p) => (p / TICK) * TICK;
const ceilTick = (p) => ((p + TICK - 1n) / TICK) * TICK;

/// 把外部來的設定（admin 寫的 JSON）整理成完整、合法的一份。不合法的欄位退回預設值，
/// 並回傳問題清單——常駐程式不能因為有人填錯一格就停擺，但要說出來。
export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, ...raw, simulation: { ...DEFAULT_CONFIG.simulation, ...(raw.simulation ?? {}) }, commands: { ...DEFAULT_CONFIG.commands, ...(raw.commands ?? {}) } };
  const problems = [];
  const num = (k, lo, hi, int = false) => {
    const v = Number(c[k]);
    if (!Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v))) {
      problems.push(`${k}=${JSON.stringify(c[k])} 不在 ${lo}–${hi}${int ? "（整數）" : ""}，改用預設 ${DEFAULT_CONFIG[k]}`);
      c[k] = DEFAULT_CONFIG[k];
    } else c[k] = v;
  };
  num("capitalTWD", 0, 1e12, true);
  num("maxInventoryTonnes", 0, 1e7);
  num("maxOrderTonnes", 0.001, 1e6);
  num("levels", 1, 10, true);
  num("spreadBps", 10, 5000, true);
  num("stepBps", 0, 5000, true);
  num("anchorPricePerTonne", 1, 1e6);
  num("floorPerTonne", 1, 1e6);
  num("ceilPerTonne", 1, 1e6);
  num("maxDailyLossTWD", 0, 1e12);
  num("requoteBps", 1, 5000, true);
  num("intervalSec", 10, 86400, true);
  num("minFillTonnes", 0.001, 1e6);
  if (c.floorPerTonne >= c.ceilPerTonne) {
    problems.push(`floorPerTonne（${c.floorPerTonne}）必須小於 ceilPerTonne（${c.ceilPerTonne}），改用預設`);
    c.floorPerTonne = DEFAULT_CONFIG.floorPerTonne; c.ceilPerTonne = DEFAULT_CONFIG.ceilPerTonne;
  }
  c.enabled = c.enabled === true;
  c.simulation.enabled = c.simulation.enabled === true;
  c.simulation.users = Math.max(1, Math.min(100, Math.round(Number(c.simulation.users) || 30)));
  c.simulation.intervalSec = Math.max(30, Math.min(86400, Math.round(Number(c.simulation.intervalSec) || 300)));
  c.commands.recall = Number(c.commands.recall) || 0;
  c.commands.resume = Number(c.commands.resume) || 0;
  return { config: c, problems };
}

/// 價差至少要蓋過手續費。賣方付費（buy 與 fillBid 都是），做市帳戶兩邊各當一次賣方與買方：
/// 買進時付的是別人的費、賣出時自己付費。最內層半邊價差 < 費率 = 每成交一輪都在賠錢。
export function spreadWarnings(config, feeBps) {
  const half = config.spreadBps / 2;
  return half < feeBps
    ? [`最內層半邊價差 ${half} bps 小於交易手續費 ${feeBps} bps：每一次賣出成交都是虧損。建議 spreadBps ≥ ${feeBps * 2 + 50}`]
    : [];
}

/// 參考價。優先順序：近期成交（量加權）→ 外部最佳買賣中價 → 設定的錨價。最後夾在上下限內。
/// 「外部」= 不是平台控制的帳戶——自己的報價不能拿來決定自己的報價，那是自我參照。
export function referencePrice({ trades = [], bestBid = null, bestAsk = null, config }) {
  const lo = toUnits(config.floorPerTonne), hi = toUnits(config.ceilPerTonne);
  const recent = trades.slice(-20);
  const kg = recent.reduce((s, t) => s + t.kg, 0);
  if (kg > 0) {
    const notional = recent.reduce((s, t) => s + t.price * BigInt(t.kg), 0n);
    return { price: clamp(notional / BigInt(kg), lo, hi), source: `近 ${recent.length} 筆成交量加權` };
  }
  if (bestBid !== null && bestAsk !== null && bestBid < bestAsk) return { price: clamp((bestBid + bestAsk) / 2n, lo, hi), source: "外部最佳買賣中價" };
  if (bestAsk !== null) return { price: clamp(bestAsk, lo, hi), source: "外部最佳賣價" };
  if (bestBid !== null) return { price: clamp(bestBid, lo, hi), source: "外部最佳買價" };
  return { price: clamp(toUnits(config.anchorPricePerTonne), lo, hi), source: "設定的錨價" };
}

/// 目標報價階梯。
///
/// 數量受三件事限制：單筆上限、部位上限（買方）、可用庫存（賣方）、可用現金（買方）。
/// 價格受兩件事限制：上下限、以及不能與外部最佳價交叉。
export function targetQuotes({ ref, config, inventoryKg, freeInventoryKg, cash, bestExternalBid = null, bestExternalAsk = null }) {
  const lo = toUnits(config.floorPerTonne), hi = toUnits(config.ceilPerTonne);
  const maxOrderKg = Math.floor(config.maxOrderTonnes * 1000);
  const minFillKg = Math.max(1, Math.floor(config.minFillTonnes * 1000));
  const bids = [], asks = [];

  // 買方的空間：部位上限扣掉現在持有的（inventoryKg 已含掛在簿子上的賣單）
  let longRoom = Math.max(0, Math.floor(config.maxInventoryTonnes * 1000) - inventoryKg);
  let cashLeft = cash;
  let invLeft = freeInventoryKg;

  for (let i = 0; i < config.levels; i++) {
    const off = BigInt(Math.round(config.spreadBps / 2 + i * config.stepBps));
    let bp = floorTick((ref * (BPS - off)) / BPS);
    let ap = ceilTick((ref * (BPS + off)) / BPS);
    if (bestExternalAsk !== null && bp >= bestExternalAsk) bp = bestExternalAsk - TICK * BigInt(i + 1);
    if (bestExternalBid !== null && ap <= bestExternalBid) ap = bestExternalBid + TICK * BigInt(i + 1);
    // 外部的單不一定落在整數價位上，退一格之後要再對齊一次
    bp = clamp(floorTick(bp), lo, hi); ap = clamp(ceilTick(ap), lo, hi);
    if (bp >= ap) continue; // 上下限太窄，這一檔掛不出去

    // 買單：錢要先鎖進合約（escrow = kg × price / 1000）
    const affordKg = Number((cashLeft * 1000n) / bp);
    const bkg = Math.min(maxOrderKg, longRoom, affordKg);
    if (bkg >= minFillKg) {
      bids.push({ price: bp, kg: bkg, level: i });
      longRoom -= bkg;
      cashLeft -= (BigInt(bkg) * bp) / 1000n;
    }
    const akg = Math.min(maxOrderKg, invLeft);
    if (akg >= minFillKg) {
      asks.push({ price: ap, kg: akg, level: i });
      invLeft -= akg;
    }
  }
  return { bids, asks, minFillKg };
}

/// 既有報價 vs 目標：留下價格夠接近的，其餘撤掉、補上缺的。
/// 一張既有的單只能對應一個目標；比對順序是價格由近到遠，不依賴 Map 的迭代順序。
export function planRequote({ current, target, requoteBps }) {
  const keep = [], cancel = [], place = [];
  const used = new Set();
  const sorted = [...target].sort((a, b) => a.level - b.level);
  for (const t of sorted) {
    let best = null, bestDiff = null;
    for (const c of current) {
      if (used.has(c.id)) continue;
      const diff = c.price > t.price ? c.price - t.price : t.price - c.price;
      const tolerance = (t.price * BigInt(requoteBps)) / BPS;
      const sizeOk = c.remainingKg >= Math.floor(t.kg / 2); // 被吃掉超過一半就重掛補量
      if (diff <= tolerance && sizeOk && (bestDiff === null || diff < bestDiff)) { best = c; bestDiff = diff; }
    }
    if (best) { used.add(best.id); keep.push(best); } else place.push(t);
  }
  for (const c of current) if (!used.has(c.id)) cancel.push(c);
  return { keep, cancel, place };
}

/// 權益（按參考價計）：現金 + 買單託管 + 持有量（含掛在簿子上的）× 參考價。
export function equityOf({ cash, bidEscrow, inventoryKg, ref }) {
  return cash + bidEscrow + (BigInt(inventoryKg) * ref) / 1000n;
}

/// 台北時間的日期字串。停損以台北的一天為單位，因為那是營運者看報表的單位。
export function taipeiDay(unixSec) {
  return new Date((unixSec + 8 * 3600) * 1000).toISOString().slice(0, 10);
}

/// 風控：當日權益跌幅超過上限 → 停止報價。不自動恢復——停損之後要人看過再按恢復。
export function riskCheck({ equity, dayStartEquity, config }) {
  if (!config.maxDailyLossTWD || dayStartEquity === null) return { halt: false };
  const loss = dayStartEquity - equity;
  const limit = BigInt(config.maxDailyLossTWD) * UNIT;
  return loss > limit
    ? { halt: true, reason: `當日權益下跌 ${Number(loss) / 1e6} 元，超過上限 ${config.maxDailyLossTWD} 元` }
    : { halt: false, loss };
}

/// 平台控制的帳戶集合（小寫）。做市帳戶不跟這裡面的任何人成交。
export function platformSet(...lists) {
  const s = new Set();
  for (const l of lists) for (const a of l ?? []) if (a) s.add(String(a).toLowerCase());
  return s;
}
export const isPlatform = (set, addr) => set.has(String(addr).toLowerCase());

/// 外部（非平台）最佳買賣價。
export function bestExternal({ orders, bids, platform }) {
  let bestAsk = null, bestBid = null;
  for (const o of orders) if (!isPlatform(platform, o.seller) && (bestAsk === null || o.price < bestAsk)) bestAsk = o.price;
  for (const b of bids) if (!isPlatform(platform, b.buyer) && (bestBid === null || b.price > bestBid)) bestBid = b.price;
  return { bestAsk, bestBid };
}
