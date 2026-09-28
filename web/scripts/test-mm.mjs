// 做市策略的單元測試（scripts/mm/strategy.mjs）。不碰鏈。
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG, UNIT, bestExternal, equityOf, normalizeConfig, planRequote, platformSet,
  referencePrice, riskCheck, spreadWarnings, targetQuotes, taipeiDay,
} from "./mm/strategy.mjs";

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`); };
const P = (twd) => BigInt(twd) * UNIT;
const cfg = (o = {}) => normalizeConfig({ ...o }).config;

t("normalizeConfig：不合法的欄位退回預設並列出問題", () => {
  const { config, problems } = normalizeConfig({ levels: 99, spreadBps: "abc", floorPerTonne: 900, ceilPerTonne: 800 });
  assert.equal(config.levels, DEFAULT_CONFIG.levels);
  assert.equal(config.spreadBps, DEFAULT_CONFIG.spreadBps);
  assert.equal(config.floorPerTonne, DEFAULT_CONFIG.floorPerTonne);
  assert.equal(problems.length, 3);
});
t("normalizeConfig：enabled 只認 true", () => {
  assert.equal(cfg({ enabled: "true" }).enabled, false);
  assert.equal(cfg({ enabled: true }).enabled, true);
});
t("參考價：有成交就用量加權成交價", () => {
  const r = referencePrice({ trades: [{ price: P(800), kg: 1000 }, { price: P(900), kg: 3000 }], config: cfg() });
  assert.equal(r.price, P(875));
});
t("參考價：沒有成交用外部中價，再沒有用錨價", () => {
  assert.equal(referencePrice({ bestBid: P(700), bestAsk: P(900), config: cfg() }).price, P(800));
  assert.equal(referencePrice({ config: cfg({ anchorPricePerTonne: 650 }) }).price, P(650));
});
t("參考價：夾在上下限內", () => {
  assert.equal(referencePrice({ trades: [{ price: P(5000), kg: 1 }], config: cfg() }).price, P(2200));
});
t("報價階梯：買在參考價下、賣在參考價上，且逐檔加寬", () => {
  const q = targetQuotes({ ref: P(1000), config: cfg(), inventoryKg: 200_000, freeInventoryKg: 200_000, cash: P(10_000_000) });
  assert.equal(q.bids.length, 3); assert.equal(q.asks.length, 3);
  assert.equal(q.bids[0].price, P(980)); assert.equal(q.asks[0].price, P(1020));
  assert.ok(q.bids[1].price < q.bids[0].price && q.asks[1].price > q.asks[0].price);
});
t("報價階梯：不與外部最佳價交叉", () => {
  const q = targetQuotes({ ref: P(1000), config: cfg(), inventoryKg: 50_000, freeInventoryKg: 50_000, cash: P(1e7), bestExternalAsk: P(960), bestExternalBid: P(1040) });
  for (const b of q.bids) assert.ok(b.price < P(960), `買價 ${b.price} 不應 ≥ 外部賣價`);
  for (const a of q.asks) assert.ok(a.price > P(1040), `賣價 ${a.price} 不應 ≤ 外部買價`);
});
t("報價階梯：外部單價位不是整數時，退一格後仍對齊整數價位", () => {
  const q = targetQuotes({ ref: P(1000), config: cfg(), inventoryKg: 50_000, freeInventoryKg: 50_000, cash: P(1e7), bestExternalAsk: P(960) + 123_456n, bestExternalBid: P(1040) + 654_321n });
  for (const x of [...q.bids, ...q.asks]) assert.equal(x.price % UNIT, 0n);
});
t("報價階梯：沒有庫存就不掛賣單，沒有現金就不掛買單", () => {
  const q1 = targetQuotes({ ref: P(1000), config: cfg(), inventoryKg: 0, freeInventoryKg: 0, cash: P(1e7) });
  assert.equal(q1.asks.length, 0); assert.ok(q1.bids.length > 0);
  const q2 = targetQuotes({ ref: P(1000), config: cfg(), inventoryKg: 10_000, freeInventoryKg: 10_000, cash: 0n });
  assert.equal(q2.bids.length, 0); assert.ok(q2.asks.length > 0);
});
t("報價階梯：部位上限限制買單總量", () => {
  const q = targetQuotes({ ref: P(1000), config: cfg({ maxInventoryTonnes: 60, maxOrderTonnes: 50 }), inventoryKg: 20_000, freeInventoryKg: 0, cash: P(1e8) });
  const total = q.bids.reduce((s, b) => s + b.kg, 0);
  assert.equal(total, 40_000);
});
t("報價階梯：現金限制買單總量（託管金額不超過現金）", () => {
  const q = targetQuotes({ ref: P(1000), config: cfg(), inventoryKg: 0, freeInventoryKg: 0, cash: P(30_000) });
  const escrow = q.bids.reduce((s, b) => s + (BigInt(b.kg) * b.price) / 1000n, 0n);
  assert.ok(escrow <= P(30_000));
});
t("重掛計畫：夠接近的留下，其他撤掉、補上缺的", () => {
  const target = [{ price: P(980), kg: 50_000, level: 0 }, { price: P(965), kg: 50_000, level: 1 }];
  const current = [
    { id: 1, price: P(981), remainingKg: 50_000 },  // 留（差 0.1% 內）
    { id: 2, price: P(900), remainingKg: 50_000 },  // 撤
  ];
  const p = planRequote({ current, target, requoteBps: 100 });
  assert.deepEqual(p.keep.map((c) => c.id), [1]);
  assert.deepEqual(p.cancel.map((c) => c.id), [2]);
  assert.equal(p.place.length, 1); assert.equal(p.place[0].price, P(965));
});
t("重掛計畫：被吃掉超過一半的單撤掉重掛", () => {
  const p = planRequote({ current: [{ id: 7, price: P(980), remainingKg: 10_000 }], target: [{ price: P(980), kg: 50_000, level: 0 }], requoteBps: 100 });
  assert.equal(p.cancel.length, 1); assert.equal(p.place.length, 1);
});
t("權益與停損", () => {
  const e = equityOf({ cash: P(100_000), bidEscrow: P(20_000), inventoryKg: 10_000, ref: P(1000) });
  assert.equal(e, P(130_000));
  assert.equal(riskCheck({ equity: P(100_000), dayStartEquity: P(125_000), config: cfg({ maxDailyLossTWD: 20_000 }) }).halt, true);
  assert.equal(riskCheck({ equity: P(110_000), dayStartEquity: P(125_000), config: cfg({ maxDailyLossTWD: 20_000 }) }).halt, false);
  assert.equal(riskCheck({ equity: 0n, dayStartEquity: P(1e9), config: cfg({ maxDailyLossTWD: 0 }) }).halt, false);
});
t("外部最佳價排除平台帳戶", () => {
  const platform = platformSet(["0xAAAA000000000000000000000000000000000001"]);
  const r = bestExternal({
    orders: [{ seller: "0xaaaa000000000000000000000000000000000001", price: P(500) }, { seller: "0xbb", price: P(900) }],
    bids: [{ buyer: "0xAAAA000000000000000000000000000000000001", price: P(1500) }, { buyer: "0xcc", price: P(700) }],
    platform,
  });
  assert.equal(r.bestAsk, P(900)); assert.equal(r.bestBid, P(700));
});
t("價差蓋不過手續費會警告", () => {
  assert.equal(spreadWarnings(cfg({ spreadBps: 150 }), 100).length, 1);
  assert.equal(spreadWarnings(cfg({ spreadBps: 400 }), 100).length, 0);
});
t("台北日期換日在 UTC 16:00", () => {
  assert.equal(taipeiDay(Date.UTC(2026, 8, 28, 15, 59) / 1000), "2026-09-28");
  assert.equal(taipeiDay(Date.UTC(2026, 8, 28, 16, 0) / 1000), "2026-09-29");
});

console.log(`\n${n} 個測試通過`);
