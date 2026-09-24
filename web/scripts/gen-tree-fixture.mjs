#!/usr/bin/env node
/**
 * 產生餘額樹的跨語言一致性 fixture。
 *
 *   cd web && npm run gen:tree-fixture
 *
 * 為什麼需要這支腳本：
 *
 * 餘額樹有兩份實作——`web/lib/bank/tree.ts` 建樹與出證據，
 * `src/bank/MerkleSumTree.sol` 在提領時驗證。兩邊的雜湊格式必須逐位元組一致。
 * 不一致的後果不是「測試紅一條」：是使用者拿著完全正確的餘額，卻領不到自己的錢，
 * 而且要等到有人真的去提領才會發現。
 *
 * 兩份實作、一份規格，這種東西不會靠人盯著看保持同步。所以：
 * TS 這邊產生一組樹與證據寫成 JSON，Foundry 那邊（test/BankTree.t.sol）讀進去驗。
 * 改動任何一邊的雜湊格式，那支測試立刻紅。
 *
 * fixture 刻意包含幾個容易出錯的形狀：
 *   · 帳戶數不是 2 的冪（落單節點要往上帶，不補假葉子）
 *   · 有帳戶完全沒有碳權（空的資產樹）
 *   · 有帳戶只有一個批次（單葉子的樹）
 *   · 有帳戶持有多個批次（batchId 要排序）
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const { buildBalanceTree, totalsHashOf } = await import("../lib/bank/tree.ts");

const EPOCH = 7n;

// 地址刻意不照字典序給，讓排序那一步真的被測到
const balances = [
  {
    account: "0xcccccccccccccccccccccccccccccccccccccccc",
    assets: [{ batchId: 42n, kg: 250_000n }, { batchId: 7n, kg: 1_000n }, { batchId: 900n, kg: 3n }],
    cash: 1_234_567n,
  },
  { account: "0x1111111111111111111111111111111111111111", assets: [{ batchId: 7n, kg: 500n }], cash: 0n },
  { account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", assets: [], cash: 99n },
  { account: "0x2222222222222222222222222222222222222222", assets: [{ batchId: 42n, kg: 12n }], cash: 5n },
  { account: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", assets: [{ batchId: 900n, kg: 77n }], cash: 10n },
];

const tree = buildBalanceTree(balances, EPOCH);

/// 每個帳戶都出一份證據，連沒有碳權的那個也要——它的資產證據會是空的，
/// 而「空的證據能不能驗過」正是容易寫錯的地方。
const cases = balances.map((b) => {
  const p = tree.proofOf(b.account);
  const firstBatch = [...b.assets].sort((x, y) => (x.batchId < y.batchId ? -1 : 1))[0];
  const asset = firstBatch ? tree.assetProofOf(b.account, firstBatch.batchId) : null;
  return {
    account: b.account,
    assetsRoot: p.assetsRoot,
    leafKg: p.leafKg.toString(),
    leafCash: p.leafCash.toString(),
    siblings: p.siblings.map((s) => ({ hash: s.hash, kg: s.kg.toString(), cash: s.cash.toString() })),
    path: p.path.toString(),
    // Foundry 的 stdJson 沒有「陣列長度」的查詢，所以數量直接寫進 fixture。
    // 讓測試去 try/catch 猜長度只會讓失敗訊息變得難讀。
    siblingCount: p.siblings.length,
    hasAsset: asset !== null,
    asset: asset
      ? { batchId: firstBatch.batchId.toString(), kg: asset.kg.toString(),
          siblings: asset.siblings, path: asset.path.toString() }
      : { batchId: "0", kg: "0", siblings: [], path: "0" },
  };
});

const out = {
  note: "由 web/scripts/gen-tree-fixture.mjs 產生。改雜湊格式就要重跑，並確認 test/BankTree.t.sol 仍然通過。",
  epoch: EPOCH.toString(),
  root: tree.root.hash,
  totalKg: tree.root.kg.toString(),
  totalCash: tree.root.cash.toString(),
  totalsHash: totalsHashOf(tree.totalsByBatch, tree.root.cash),
  totalsByBatch: tree.totalsByBatch.map((t) => ({ batchId: t.batchId.toString(), kg: t.kg.toString() })),
  caseCount: cases.length,
  cases,
};

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "balance-tree.json");
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);

console.log(`餘額樹 fixture → ${file}`);
console.log(`  epoch ${out.epoch}、${cases.length} 個帳戶、root ${out.root}`);
console.log(`  總額 ${out.totalKg} kg / ${out.totalCash}（結算幣最小單位）`);
