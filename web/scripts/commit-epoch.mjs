#!/usr/bin/env node
/**
 * 提交一期的餘額樹 root。
 *
 *   cd web
 *   npm run bank:plan      # 只看要提交什麼，不送出
 *   npm run bank:commit    # 真的送出
 *
 * 每 24 小時跑一次（決策：錨定頻率 24 小時）。
 *
 * ## 為什麼這支腳本不經過 Next
 *
 * 它要能在 cron 裡跑、在另一台機器上跑，而查核機構更要能自己跑一份來對帳——
 * 沒有人會為了重算一棵樹去啟動一個 Next 伺服器。所以推導邏輯放在
 * `lib/bank/ledger-core.ts`（不依賴 Next、不用路徑別名），這裡自己開 client 注入。
 *
 * ## plan / commit 兩步
 *
 * 每天自動跑的東西要有一個可以先 dry-run 的形狀。而且 plan 會印出
 * 「帳本說欠多少、池子裡有多少」——那個差如果不是預期中的（還沒入帳的存入），
 * 就不該提交，要先查清楚。
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { totalsHashOf } = await import("../lib/bank/tree.ts");
const { replay, checkExternalEvents } = await import("../lib/bank/replay.ts");
const { toBalances } = await import("../lib/bank/engine.ts");

const dry = process.argv.includes("--dry-run") || process.argv.includes("--plan");
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:28545";

const bankAbi = parseAbi([
  "function head() view returns (bytes32)",
  "function epoch() view returns (uint64)",
  "function solvency() view returns (uint256 owedKg, uint256 heldKg, uint256 owedCash, uint256 heldCash)",
  "function commit(bytes32 prev, uint64 newEpoch, bytes32 orderLogRoot, bytes32 balanceRoot, uint256 totalKg, uint256 totalCash, bytes32 totalsHash, uint64 upToBlock, uint64 lastSeq) returns (bytes32)",
]);

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
if (!D.bank) {
  console.error(`部署檔 ${depFile} 裡沒有 bank 位址——資產池是後來才加的，請重新部署`);
  process.exit(1);
}

/// 委託單 log（JSONL）。這支腳本不經過 Next，所以自己讀檔——
/// 格式與 lib/server/bank/log-store.ts 寫出去的一致。
function readLog() {
  const dir = process.env.ORDERLOG_DIR ?? path.resolve(process.cwd(), "data", "orderlog");
  const file = path.join(dir, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  const reviver = (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l, reviver))
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
}

const [head, current, solvency, toBlock] = await Promise.all([
  client.readContract({ address: D.bank, abi: bankAbi, functionName: "head" }),
  client.readContract({ address: D.bank, abi: bankAbi, functionName: "epoch" }),
  client.readContract({ address: D.bank, abi: bankAbi, functionName: "solvency" }),
  client.getBlockNumber(),
]);

// 委託單 log 是餘額的來源，不是鏈上餘額——B 期之後，帳上的數字包含了鏈下成交。
// 鏈上事件仍然要對，但它的角色變成「log 裡宣稱的外部事件是不是真的」（見下）。
const events = readLog();
if (events.length === 0) {
  console.log("委託單 log 是空的，這一期沒有東西可以提交。");
  process.exit(0);
}
const epoch = current + 1n;
const r = replay(events, epoch, D.treasury);
if (r.tree.root.kg === 0n && r.tree.root.cash === 0n) {
  console.log("重播之後沒有任何餘額，不需要提交。");
  process.exit(0);
}
const tree = r.tree;
const totalsHash = totalsHashOf(tree.totalsByBatch, tree.root.cash);
const lastSeq = events[events.length - 1].seq;
const accountCount = toBalances(r.state, D.treasury).length;
const [, heldKg, , heldCash] = solvency;

// log 裡宣稱的外部事件，鏈上真的有嗎？
//
// 這一道和重播是**獨立**的兩件事。重播只保證「餘額是從 log 算出來的」；
// 如果交易所可以在 log 裡塞一筆不存在的存入，餘額樹會完全自洽，而池子裡沒有那些東西。
const ext = await checkExternalEvents({
  client, bank: D.bank, fromBlock: BigInt(D.deployedAtBlock ?? 0), toBlock, events,
});

const kg = (v) => `${(Number(v) / 1000).toLocaleString("zh-TW")} 噸`;
const twd = (v) => `${(Number(v) / 1e6).toLocaleString("zh-TW")} mTWD`;

console.log(`第 ${epoch} 期`);
console.log(`  委託單        ${r.events} 筆（到第 ${lastSeq} 號）、成交 ${r.fills} 筆、拒絕 ${r.rejected.length} 筆`);
console.log(`  帳戶數        ${accountCount}`);
console.log(`  算到區塊      ${toBlock}`);
console.log(`  上一個 anchor ${head}`);
console.log(`  委託單 root   ${r.orderLogRoot}`);
console.log(`  事件鏈 head   ${r.runningHash}`);
console.log(`  餘額樹 root   ${tree.root.hash}`);
console.log(`  totalsHash    ${totalsHash}（${tree.totalsByBatch.length} 個批次）`);
console.log(`  碳權  帳本 ${kg(tree.root.kg)} / 池子 ${kg(heldKg)}（差 ${kg(heldKg - tree.root.kg)}）`);
console.log(`  現金  帳本 ${twd(tree.root.cash)} / 池子 ${twd(heldCash)}（差 ${twd(heldCash - tree.root.cash)}）`);

if (!ext.ok) {
  console.error(`\n外部事件對不上鏈（${ext.checked} 筆檢查）：`);
  for (const p2 of ext.problems.slice(0, 10)) console.error(`  · ${p2}`);
  console.error("不要提交——log 裡宣稱的存入／提領與鏈上不符。");
  process.exit(1);
}
console.log(`  外部事件      ${ext.checked} 筆，與鏈上相符`);

// 合約也會擋（Insolvent），但在這裡先擋一次，錯誤訊息才說得出是哪一邊多了。
if (tree.root.kg > heldKg || tree.root.cash > heldCash) {
  console.error("\n帳本宣稱的比池子裡實際有的多。不要提交這個 root——先查清楚差在哪裡。");
  process.exit(1);
}

if (dry) {
  console.log("\n（--plan，沒有送出）");
  process.exit(0);
}

const pk = process.env.COMMITTER_PK ?? process.env.RELAYER_PK;
if (!pk) {
  console.error("\n需要 COMMITTER_PK（或 RELAYER_PK）才能送出。");
  process.exit(1);
}
const wallet = createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(RPC) });

const { request } = await client.simulateContract({
  address: D.bank, abi: bankAbi, functionName: "commit",
  args: [head, epoch, r.orderLogRoot, tree.root.hash, tree.root.kg, tree.root.cash, totalsHash, toBlock, lastSeq],
  account: wallet.account,
});
const hash = await wallet.writeContract(request);
const rc = await client.waitForTransactionReceipt({ hash });
if (rc.status !== "success") {
  console.error(`\n交易被拒絕：${hash}`);
  process.exit(1);
}
console.log(`\n已提交第 ${epoch} 期，交易 ${hash}`);
