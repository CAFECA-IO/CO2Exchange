#!/usr/bin/env node
/**
 * 撮合引擎的性質測試。
 *
 *   cd web && npm run test:engine
 *
 * 這支測的不是「買賣算得對不對」那種功能測試——那當然也測——而是幾個
 * **如果不成立，整個可驗證性就塌掉**的性質：
 *
 *   ① 決定性：同一串事件跑兩次，餘額樹 root 位元組等同
 *   ② 順序敏感：換了事件順序，結果就該不同（否則「有序」是假的）
 *   ③ 守恆：撮合不會生出或吃掉碳權與現金
 *   ④ 鎖定的東西仍然算使用者的（餘額樹總額 = 池子應有的量）
 *   ⑤ 拒絕也是決定性的：同一筆壞事件，重播時以同樣理由被拒絕
 *
 * 為什麼用腳本而不是 Foundry：引擎在 TypeScript 這一側。Solidity 那邊
 * 只驗 Merkle 證據，`test/BankTree.t.sol` 已經守著兩邊的雜湊一致性。
 */
const { emptyState, apply, toBalances, notional } = await import("../lib/bank/engine.ts");
const { buildBalanceTree } = await import("../lib/bank/tree.ts");
const { eventHash, chainHash, orderLogRoot, GENESIS } = await import("../lib/bank/log.ts");

let failed = 0;
const ok = (c, m) => {
  if (c) console.log("  ✓", m);
  else { failed += 1; console.log("  ✗", m); }
};

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
const TREASURY = "0xdddddddddddddddddddddddddddddddddddddddd";
const REF = { txHash: `0x${"11".repeat(32)}`, block: 1n, logIndex: 0 };

let seq = 0n;
const ev = (o) => ({ seq: ++seq, at: 1_000_000n + seq, ...o });

/// 一份有內容的劇本：兩個賣方、一個買方、部分成交、撤單、過期單、餘額不足。
function script() {
  seq = 0n;
  return [
    ev({ kind: "config", feeBps: 100n }), // 1%
    ev({ kind: "deposit", ref: REF, account: A, batchId: 7n, amountKg: 10_000n }),
    ev({ kind: "deposit", ref: REF, account: B, batchId: 7n, amountKg: 5_000n }),
    ev({ kind: "cashDeposit", ref: REF, account: C, amount: 10_000_000_000n }),
    // A 掛 3 噸 @ 800、B 掛 2 噸 @ 750（B 比較便宜，應該先被吃）
    ev({ kind: "place", account: A, side: "sell", batchId: 7n, country: "TW", amountKg: 3_000n,
         pricePerTonne: 800_000_000n, minFillKg: 0n, expiry: 9_000_000n, nonce: 1n, signature: "0x" }),
    ev({ kind: "place", account: B, side: "sell", batchId: 7n, country: "TW", amountKg: 2_000n,
         pricePerTonne: 750_000_000n, minFillKg: 0n, expiry: 9_000_000n, nonce: 1n, signature: "0x" }),
    // C 買 4 噸 @ 820 → 先吃 B 的 2 噸 @750，再吃 A 的 2 噸 @800
    ev({ kind: "place", account: C, side: "buy", batchId: 7n, country: "TW", amountKg: 4_000n,
         pricePerTonne: 820_000_000n, minFillKg: 0n, expiry: 9_000_000n, nonce: 1n, signature: "0x" }),
    // A 撤掉剩下的 1 噸
    ev({ kind: "cancel", account: A, orderSeq: 5n, nonce: 2n, signature: "0x" }),
    // 餘額不足的單（B 手上只剩 3 噸）
    ev({ kind: "place", account: B, side: "sell", batchId: 7n, country: "TW", amountKg: 99_000n,
         pricePerTonne: 700_000_000n, minFillKg: 0n, expiry: 9_000_000n, nonce: 2n, signature: "0x" }),
    // nonce 重放
    ev({ kind: "place", account: B, side: "sell", batchId: 7n, country: "TW", amountKg: 100n,
         pricePerTonne: 700_000_000n, minFillKg: 0n, expiry: 9_000_000n, nonce: 2n, signature: "0x" }),
  ];
}

const run = (events) => {
  const s = apply(emptyState(), events);
  return { s, balances: toBalances(s, TREASURY) };
};

console.log("撮合引擎");

// ── ① 決定性 ────────────────────────────────────────────────
{
  const r1 = buildBalanceTree(run(script()).balances, 1n);
  const r2 = buildBalanceTree(run(script()).balances, 1n);
  ok(r1.root.hash === r2.root.hash, `同一串事件跑兩次得到同一個 root（${r1.root.hash.slice(0, 14)}…）`);
}

// ── ② 順序敏感 ──────────────────────────────────────────────
//
// 要測「順序有意義」，就得測**順序真的是決定因素**的那個情況：同價的兩張單，
// 由序號決定誰先成交。價格不同的話是價格優先在做決定，把它們對調換不出差別——
// 第一版的這個測試就是這樣寫錯的，它驗過了，但驗的不是順序。
{
  const mk = (a, b) => {
    seq = 0n;
    return [
      ev({ kind: "deposit", ref: REF, account: a, batchId: 7n, amountKg: 2_000n }),
      ev({ kind: "deposit", ref: REF, account: b, batchId: 7n, amountKg: 2_000n }),
      ev({ kind: "cashDeposit", ref: REF, account: C, amount: 10_000_000_000n }),
      // 同價。先掛的先成交。
      ev({ kind: "place", account: a, side: "sell", batchId: 7n, country: "TW", amountKg: 2_000n,
           pricePerTonne: 800_000_000n, minFillKg: 0n, expiry: 9_000_000n, nonce: 1n, signature: "0x" }),
      ev({ kind: "place", account: b, side: "sell", batchId: 7n, country: "TW", amountKg: 2_000n,
           pricePerTonne: 800_000_000n, minFillKg: 0n, expiry: 9_000_000n, nonce: 1n, signature: "0x" }),
      // 只買得起其中一張
      ev({ kind: "place", account: C, side: "buy", batchId: 7n, country: "TW", amountKg: 2_000n,
           pricePerTonne: 800_000_000n, minFillKg: 0n, expiry: 9_000_000n, nonce: 1n, signature: "0x" }),
    ];
  };
  const first = run(mk(A, B));
  const second = run(mk(B, A));
  ok(first.s.fills[0].seller.toLowerCase() === A, "同價時先掛的先成交（A 在前）");
  ok(second.s.fills[0].seller.toLowerCase() === B, "順序對調之後換 B 先成交");
  ok(buildBalanceTree(first.balances, 1n).root.hash !== buildBalanceTree(second.balances, 1n).root.hash,
     "而且兩者的餘額樹 root 不同——順序真的進到了狀態裡");
}

// ── ③ 守恆 ──────────────────────────────────────────────────
{
  const { balances } = run(script());
  const totalKg = balances.reduce((s2, b) => s2 + b.assets.reduce((t, x) => t + x.kg, 0n), 0n);
  const totalCash = balances.reduce((s2, b) => s2 + b.cash, 0n);
  ok(totalKg === 15_000n, `碳權守恆：存入 15,000 kg，撮合後仍是 ${totalKg} kg`);
  ok(totalCash === 10_000_000_000n, `現金守恆（含國庫手續費）：${totalCash}`);
}

// ── ④ 撮合結果本身 ──────────────────────────────────────────
{
  const { s } = run(script());
  ok(s.fills.length === 2, `成交兩筆（${s.fills.map((f) => `${f.amountKg / 1000n}噸@${f.pricePerTonne / 1_000_000n}`).join("、")}）`);
  ok(s.fills[0].pricePerTonne === 750_000_000n, "價格優先：先吃比較便宜的那一張");
  ok(s.fills[0].seller.toLowerCase() === B, "而且賣方是掛比較低價的 B");
  ok(s.fills[1].pricePerTonne === 800_000_000n, "再吃比較貴的那一張");

  // 買方掛 820 卻以 750/800 成交，差額要退回可動用餘額，不能留在鎖定裡
  const locked = s.lockedCash.get(C) ?? 0n;
  ok(locked === 0n, `買單完全成交後沒有殘留的鎖定現金（${locked}）`);

  const expectCost = notional(2_000n, 750_000_000n) + notional(2_000n, 800_000_000n);
  const cAsset = (s.credits.get(C) ?? new Map()).get("7") ?? 0n;
  ok(cAsset === 4_000n, `買方拿到 4 噸（${cAsset} kg）`);
  ok((s.cash.get(C) ?? 0n) === 10_000_000_000n - expectCost, "買方付出的正是兩筆成交的金額和");
  ok(s.treasuryCash === (expectCost * 100n) / 10_000n, `手續費 1% 進國庫（${s.treasuryCash}）`);
}

// ── ⑤ 鎖定的東西仍然算使用者的 ─────────────────────────────
{
  seq = 0n;
  const evs = [
    ev({ kind: "deposit", ref: REF, account: A, batchId: 7n, amountKg: 1_000n }),
    ev({ kind: "place", account: A, side: "sell", batchId: 7n, country: "TW", amountKg: 1_000n,
         pricePerTonne: 800_000_000n, minFillKg: 0n, expiry: 9_000_000n, nonce: 1n, signature: "0x" }),
  ];
  const { balances } = run(evs);
  const total = balances.reduce((s2, b) => s2 + b.assets.reduce((t, x) => t + x.kg, 0n), 0n);
  ok(total === 1_000n, "掛在簿子上的額度仍然算在餘額樹裡（否則樹的總額會小於池子）");
}

// ── ⑥ 拒絕也是決定性的 ─────────────────────────────────────
{
  const r1 = run(script()).s.rejected;
  const r2 = run(script()).s.rejected;
  ok(JSON.stringify(r1, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
     === JSON.stringify(r2, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
     `被拒絕的事件與理由每次都一樣（${r1.length} 筆：${r1.map((x) => x.reason).join("、")}）`);
  ok(r1.length === 2, "餘額不足與 nonce 重放各被擋一次");
}

// ── ⑦ 不自成交 ──────────────────────────────────────────────
{
  seq = 0n;
  const evs = [
    ev({ kind: "deposit", ref: REF, account: A, batchId: 7n, amountKg: 1_000n }),
    ev({ kind: "cashDeposit", ref: REF, account: A, amount: 10_000_000_000n }),
    ev({ kind: "place", account: A, side: "sell", batchId: 7n, country: "TW", amountKg: 1_000n,
         pricePerTonne: 800_000_000n, minFillKg: 0n, expiry: 9_000_000n, nonce: 1n, signature: "0x" }),
    ev({ kind: "place", account: A, side: "buy", batchId: 7n, country: "TW", amountKg: 1_000n,
         pricePerTonne: 900_000_000n, minFillKg: 0n, expiry: 9_000_000n, nonce: 2n, signature: "0x" }),
  ];
  ok(run(evs).s.fills.length === 0, "自己不跟自己成交（洗量在這裡就被擋掉）");
}

// ── ⑧ 過期單不撮合 ─────────────────────────────────────────
{
  seq = 0n;
  const evs = [
    ev({ kind: "deposit", ref: REF, account: A, batchId: 7n, amountKg: 1_000n }),
    ev({ kind: "cashDeposit", ref: REF, account: C, amount: 10_000_000_000n }),
    ev({ kind: "place", account: A, side: "sell", batchId: 7n, country: "TW", amountKg: 1_000n,
         pricePerTonne: 800_000_000n, minFillKg: 0n, expiry: 1_000_004n, nonce: 1n, signature: "0x" }),
  ];
  // 這一筆的邏輯時間已經超過上面那張單的 expiry
  evs.push({ seq: ++seq, at: 2_000_000n, kind: "place", account: C, side: "buy", batchId: 7n, country: "TW",
             amountKg: 1_000n, pricePerTonne: 900_000_000n, minFillKg: 0n, expiry: 9_000_000n, nonce: 1n, signature: "0x" });
  ok(run(evs).s.fills.length === 0, "過期的掛單不會被撮合（時間來自事件，不是牆上時鐘）");
}

// ── ⑨ log 的雜湊鏈與 Merkle root ───────────────────────────
{
  const evs = script();
  let h1 = GENESIS, h2 = GENESIS;
  for (const e of evs) h1 = chainHash(h1, e);
  for (const e of evs) h2 = chainHash(h2, e);
  ok(h1 === h2, `事件鏈雜湊是決定性的（${h1.slice(0, 14)}…）`);

  const changed = script();
  changed[6] = { ...changed[6], amountKg: 4_001n };
  let h3 = GENESIS;
  for (const e of changed) h3 = chainHash(h3, e);
  ok(h1 !== h3, "改掉任何一筆事件，鏈就斷了");

  ok(orderLogRoot(evs) === orderLogRoot(script()), "批次的 Merkle root 也是決定性的");
  ok(orderLogRoot(evs) !== orderLogRoot(changed), "而且改一筆就會變");
  ok(eventHash(evs[0]) !== eventHash(evs[1]), "不同事件的雜湊不同");
}

console.log();
if (failed > 0) { console.error(`${failed} 項未通過`); process.exit(1); }
console.log("撮合引擎：全部通過");
