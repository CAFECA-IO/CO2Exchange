#!/usr/bin/env node
/**
 * 獨立驗證某一期的餘額樹承諾。
 *
 *   cd web
 *   npm run bank:verify                      # 驗最新一期
 *   npm run bank:verify -- --epoch 3
 *   npm run bank:verify -- --account 0x…     # 順便驗這個帳戶的證據
 *
 * ## 這支腳本就是「可驗證」這三個字的全部內容
 *
 * A 期對外的承諾是：**交易所說每個人有多少，任何人都能自己算一次對照。**
 * 沒有這支工具，那句話只是形容詞。
 *
 * 它不需要交易所配合，也不需要 Next 伺服器——只要一個 RPC 端點和部署檔。
 * 查核機構、主管機關，或任何拿得到節點的人，都可以自己跑：
 *
 *   1. 從鏈上讀第 N 期的承諾（balanceRoot、總額、upToBlock）
 *   2. 從鏈上事件重新推導出所有人的餘額（只讀到 upToBlock 為止）
 *   3. 重建餘額樹，比對 root 與總額
 *   4. 對照池子裡實際持有多少
 *
 * 對不上就 exit 1，而且印出差在哪裡。
 *
 * 注意第 2 步：**只讀到 upToBlock 為止**。這就是為什麼那個欄位要上鏈——
 * 少了它，重算的人不知道該讀到哪裡，多讀或少讀一個區塊都會得到不同的 root，
 * 而他無法判斷是自己讀錯還是交易所報錯。
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, defineChain, http, parseAbi } from "viem";

const { buildBalanceTree, totalsHashOf } = await import("../lib/bank/tree.ts");
const { deriveLedger } = await import("../lib/bank/ledger-core.ts");

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
};

const RPC = arg("rpc") ?? process.env.RPC_URL ?? "http://127.0.0.1:28545";
const bankAbi = parseAbi([
  "function epoch() view returns (uint64)",
  "function totalHeldKg() view returns (uint256)",
  "function commitments(uint64) view returns (bytes32 orderLogRoot, bytes32 balanceRoot, uint256 totalKg, uint256 totalCash, bytes32 totalsHash, uint64 upToBlock, uint64 committedAt)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const pub0 = createPublicClient({ transport: http(RPC) });
const chainId = await pub0.getChainId().catch(() => {
  console.error(`連不上 ${RPC}`);
  process.exit(1);
});
const chain = defineChain({
  id: chainId, name: "co2x",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const client = createPublicClient({ chain, transport: http(RPC) });

const depFile = process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`);
const D = JSON.parse(fs.readFileSync(depFile, "utf8"));
if (!D.bank) { console.error(`部署檔裡沒有 bank 位址：${depFile}`); process.exit(1); }

const latest = await client.readContract({ address: D.bank, abi: bankAbi, functionName: "epoch" });
const epoch = arg("epoch") ? BigInt(arg("epoch")) : latest;
if (epoch === 0n) { console.error("這條鏈上還沒有任何一期的承諾。"); process.exit(1); }

const [, balanceRoot, totalKg, totalCash, totalsHash, upToBlock, committedAt] =
  await client.readContract({ address: D.bank, abi: bankAbi, functionName: "commitments", args: [epoch] });

console.log(`第 ${epoch} 期（chainId ${chainId}）`);
console.log(`  提交於      ${new Date(Number(committedAt) * 1000).toISOString()}`);
console.log(`  算到區塊    ${upToBlock}`);
console.log(`  鏈上 root   ${balanceRoot}\n`);

const ledger = await deriveLedger({
  client, bank: D.bank, fromBlock: BigInt(D.deployedAtBlock ?? 0), toBlock: BigInt(upToBlock),
});
if (ledger.balances.length === 0) { console.error("重新推導出 0 個帳戶，但鏈上有承諾——對不上。"); process.exit(1); }

const tree = buildBalanceTree(ledger.balances, epoch);
const computedTotals = totalsHashOf(tree.totalsByBatch, tree.root.cash);

let bad = 0;
const check = (label, expected, got) => {
  const okay = String(expected) === String(got);
  if (!okay) bad += 1;
  console.log(`  ${okay ? "✓" : "✗"} ${label}`);
  if (!okay) console.log(`      鏈上 ${expected}\n      重算 ${got}`);
};

console.log(`重新推導（${ledger.balances.length} 個帳戶、${tree.totalsByBatch.length} 個批次）`);
check("餘額樹 root", balanceRoot, tree.root.hash);
check("總公斤數", totalKg, tree.root.kg);
check("總結算幣", totalCash, tree.root.cash);
check("逐批次明細 totalsHash", totalsHash, computedTotals);

// 償付能力：宣稱欠多少 vs 池子裡實際有多少。
const heldKg = await client.readContract({ address: D.bank, abi: bankAbi, functionName: "totalHeldKg" });
const heldCash = await client.readContract({ address: D.settlementToken, abi: erc20Abi, functionName: "balanceOf", args: [D.bank] });
console.log(`\n償付能力`);
console.log(`  ${totalKg <= heldKg ? "✓" : "✗"} 碳權：欠 ${totalKg} kg / 池子裡 ${heldKg} kg（差 ${heldKg - totalKg}）`);
console.log(`  ${totalCash <= heldCash ? "✓" : "✗"} 現金：欠 ${totalCash} / 池子裡 ${heldCash}（差 ${heldCash - totalCash}）`);
if (totalKg > heldKg || totalCash > heldCash) bad += 1;

// 逐批次對照：這是 totalsHash 那張公開表真正的用處。
console.log(`\n逐批次對照`);
const creditAbi = parseAbi(["function balanceOf(address,uint256) view returns (uint256)"]);
for (const t of tree.totalsByBatch) {
  const held = await client.readContract({
    address: D.carbonCredit1155, abi: creditAbi, functionName: "balanceOf", args: [D.bank, t.batchId],
  });
  const okay = t.kg <= held;
  if (!okay) bad += 1;
  console.log(`  ${okay ? "✓" : "✗"} 批次 ${t.batchId}：帳本 ${t.kg} kg / 池子 ${held} kg`);
}

// 單一帳戶的證據
const account = arg("account");
if (account) {
  console.log(`\n${account} 的證據`);
  try {
    const p = tree.proofOf(account);
    console.log(`  ✓ 這個帳戶在第 ${epoch} 期的樹裡`);
    console.log(`     碳權 ${p.leafKg} kg、現金 ${p.leafCash}`);
    console.log(`     assetsRoot ${p.assetsRoot}`);
    console.log(`     兄弟節點 ${p.siblings.length} 個、path 0b${p.path.toString(2)}`);
    for (const a of ledger.balances.find((b) => b.account.toLowerCase() === account.toLowerCase()).assets) {
      const ap = tree.assetProofOf(account, a.batchId);
      console.log(`     批次 ${a.batchId}：${ap.kg} kg，資產樹兄弟 ${ap.siblings.length} 個`);
    }
  } catch (e) {
    bad += 1;
    console.log(`  ✗ ${e.message}`);
  }
}

console.log();
if (bad > 0) {
  console.error(`有 ${bad} 項對不上。這表示鏈上的承諾與鏈上事件推導出來的結果不一致——`);
  console.error(`要嘛推導的程式有錯，要嘛提交的 root 不是從這些事件算出來的。兩種都要查。`);
  process.exit(1);
}
console.log("全部對得上。");
