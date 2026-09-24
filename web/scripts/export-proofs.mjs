#!/usr/bin/env node
/**
 * 把某一期**每一個帳戶**的提領證據匯出成獨立檔案。
 *
 *   cd web
 *   npm run bank:proofs                 # 最新一期
 *   npm run bank:proofs -- --epoch 3 --out ../proofs
 *
 * ## 為什麼這支腳本存在
 *
 * 逃生門的三個要件裡，最容易被省略、也最致命的是第二個：
 * **使用者要拿得到自己的葉子與證據。**
 *
 * 合約端的逃生模式做得再好，如果產生證據的唯一途徑是交易所的 API，
 * 那麼營運方消失的那一刻證據也跟著消失——而那正是逃生門唯一會被用到的時候。
 * 一個需要對方配合才能用的逃生門，是裝飾品。
 *
 * 所以每一期都要把證據**推出去**：
 *   · 每個使用者拿自己那一份（下載、或寄出）
 *   · 查核機構與主管機關的鏡像節點拿全部
 *
 * 匯出的每一份都是**自足的**：帶著鏈、合約地址、epoch、葉子與路徑。
 * 拿著它加上一個 RPC 端點就能呼叫 `withdraw`，不需要這個網站還活著。
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, defineChain, http, parseAbi } from "viem";

const { replay } = await import("../lib/bank/replay.ts");

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
};

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:28545";
const bankAbi = parseAbi([
  "function epoch() view returns (uint64)",
  "function commitments(uint64) view returns (bytes32,bytes32,uint256,uint256,bytes32,uint64,uint64,uint64)",
]);

const pub0 = createPublicClient({ transport: http(RPC) });
const chainId = await pub0.getChainId();
const chain = defineChain({
  id: chainId, name: "co2x",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const client = createPublicClient({ chain, transport: http(RPC) });
const D = JSON.parse(fs.readFileSync(
  process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`), "utf8"));

const latest = await client.readContract({ address: D.bank, abi: bankAbi, functionName: "epoch" });
const epoch = arg("epoch") ? BigInt(arg("epoch")) : latest;
if (epoch === 0n) { console.error("這條鏈上還沒有任何一期的承諾。"); process.exit(1); }

const c = await client.readContract({ address: D.bank, abi: bankAbi, functionName: "commitments", args: [epoch] });
const balanceRoot = c[1];
const lastSeq = c[6];

function readLog(upTo) {
  const dir = process.env.ORDERLOG_DIR ?? path.resolve(process.cwd(), "data", "orderlog");
  const file = path.join(dir, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  const reviver = (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l, reviver))
    .filter((e) => e.seq <= upTo)
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
}

const { tree, state } = replay(readLog(BigInt(lastSeq)), epoch, D.treasury);
if (tree.root.hash !== balanceRoot) {
  console.error(`重播出來的 root 和鏈上第 ${epoch} 期對不上，不要匯出會驗不過的證據。`);
  console.error(`  鏈上 ${balanceRoot}\n  重算 ${tree.root.hash}`);
  process.exit(1);
}

const accounts = new Set([
  ...state.credits.keys(), ...state.cash.keys(),
  ...state.lockedCredits.keys(), ...state.lockedCash.keys(),
]);
if (D.treasury) accounts.add(D.treasury.toLowerCase());

const outDir = path.resolve(arg("out") ?? path.join("data", "proofs", `epoch-${epoch}`));
fs.mkdirSync(outDir, { recursive: true });

const big = (v) => (typeof v === "bigint" ? v.toString() : v);
let n = 0;
for (const a of [...accounts].sort()) {
  let p;
  try { p = tree.proofOf(a); } catch { continue; } // 這一期沒有餘額
  const assets = [];
  for (const t of tree.totalsByBatch) {
    try {
      const ap = tree.assetProofOf(a, t.batchId);
      assets.push({ batchId: big(t.batchId), kg: big(ap.kg), siblings: ap.siblings, path: big(ap.path) });
    } catch { /* 這個帳戶沒有這個批次 */ }
  }

  const bundle = {
    note: "自足的提領證據。拿著這份檔案與任何一個 RPC 端點就能呼叫 Bank.withdraw，不需要交易所的網站還活著。",
    chainId,
    bank: D.bank,
    epoch: big(epoch),
    balanceRoot,
    account: a,
    leaf: { assetsRoot: p.assetsRoot, kg: big(p.leafKg), cash: big(p.leafCash) },
    siblings: p.siblings.map((s) => ({ hash: s.hash, kg: big(s.kg), cash: big(s.cash) })),
    path: big(p.path),
    assets,
    howTo: [
      "1. 確認鏈上 Bank.commitments(epoch).balanceRoot 等於這份檔案的 balanceRoot",
      "2. 若 Bank.escapeActive() 為 true（營運方超過 72 小時沒有提交承諾），不需要任何人同意就能提領",
      "3. 呼叫 withdraw(batchId, amountKg, proof) 或 withdrawCash(amount, proof)",
      "4. 池子不足時會依先到先得付出能付的部分，差額以 Shortfall 事件記在鏈上，作為向平台請求補足的依據",
    ],
  };
  fs.writeFileSync(path.join(outDir, `${a}.json`), `${JSON.stringify(bundle, null, 2)}\n`);
  n += 1;
}

// 鏡像節點要的那一份：整棵樹的輸入（log）與結果（root），讓它能自己重算並服務任何人的證據。
fs.writeFileSync(path.join(outDir, "_epoch.json"), `${JSON.stringify({
  chainId, bank: D.bank, epoch: big(epoch), balanceRoot,
  totalKg: big(tree.root.kg), totalCash: big(tree.root.cash),
  lastSeq: big(lastSeq), accounts: n,
  totalsByBatch: tree.totalsByBatch.map((t) => ({ batchId: big(t.batchId), kg: big(t.kg) })),
}, null, 2)}\n`);

console.log(`第 ${epoch} 期的提領證據 → ${outDir}`);
console.log(`  ${n} 個帳戶各一份，外加 _epoch.json（鏡像節點用）`);
console.log(`  每一份都是自足的：帶著鏈、合約地址、epoch、葉子與路徑`);
console.log(`\n這些檔案要真的送到使用者與鏡像機構手上——留在伺服器裡的話，`);
console.log(`營運方消失的那一刻它們也跟著消失，而那正是逃生門唯一會被用到的時候。`);
