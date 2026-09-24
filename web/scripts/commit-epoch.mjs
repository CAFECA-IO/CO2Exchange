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

const { buildBalanceTree, totalsHashOf } = await import("../lib/bank/tree.ts");
const { deriveLedger } = await import("../lib/bank/ledger-core.ts");

const dry = process.argv.includes("--dry-run") || process.argv.includes("--plan");
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:28545";

const bankAbi = parseAbi([
  "function head() view returns (bytes32)",
  "function epoch() view returns (uint64)",
  "function solvency() view returns (uint256 owedKg, uint256 heldKg, uint256 owedCash, uint256 heldCash)",
  "function commit(bytes32 prev, uint64 newEpoch, bytes32 orderLogRoot, bytes32 balanceRoot, uint256 totalKg, uint256 totalCash, bytes32 totalsHash, uint64 upToBlock) returns (bytes32)",
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

const [head, current, solvency, toBlock] = await Promise.all([
  client.readContract({ address: D.bank, abi: bankAbi, functionName: "head" }),
  client.readContract({ address: D.bank, abi: bankAbi, functionName: "epoch" }),
  client.readContract({ address: D.bank, abi: bankAbi, functionName: "solvency" }),
  client.getBlockNumber(),
]);

const ledger = await deriveLedger({
  client, bank: D.bank, fromBlock: BigInt(D.deployedAtBlock ?? 0), toBlock,
});
if (ledger.balances.length === 0) {
  console.log("這一期沒有任何帳戶有餘額，不需要提交。");
  process.exit(0);
}

const epoch = current + 1n;
const tree = buildBalanceTree(ledger.balances, epoch);
const totalsHash = totalsHashOf(tree.totalsByBatch, tree.root.cash);
const [, heldKg, , heldCash] = solvency;

const kg = (v) => `${(Number(v) / 1000).toLocaleString("zh-TW")} 噸`;
const twd = (v) => `${(Number(v) / 1e6).toLocaleString("zh-TW")} mTWD`;

console.log(`第 ${epoch} 期`);
console.log(`  帳戶數        ${ledger.balances.length}`);
console.log(`  算到區塊      ${toBlock}`);
console.log(`  上一個 anchor ${head}`);
console.log(`  餘額樹 root   ${tree.root.hash}`);
console.log(`  totalsHash    ${totalsHash}（${tree.totalsByBatch.length} 個批次）`);
console.log(`  碳權  帳本 ${kg(tree.root.kg)} / 池子 ${kg(heldKg)}（差 ${kg(heldKg - tree.root.kg)}）`);
console.log(`  現金  帳本 ${twd(tree.root.cash)} / 池子 ${twd(heldCash)}（差 ${twd(heldCash - tree.root.cash)}）`);

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

// orderLogRoot 在 A 期是零：委託單 log 是 B 期的事。欄位現在就留著而不是之後再加，
// 因為 anchor 的組成一旦改變，之前所有的 anchor 就要用不同公式重算——那等於承諾鏈斷掉。
const ZERO = `0x${"0".repeat(64)}`;
const { request } = await client.simulateContract({
  address: D.bank, abi: bankAbi, functionName: "commit",
  args: [head, epoch, ZERO, tree.root.hash, tree.root.kg, tree.root.cash, totalsHash, toBlock],
  account: wallet.account,
});
const hash = await wallet.writeContract(request);
const rc = await client.waitForTransactionReceipt({ hash });
if (rc.status !== "success") {
  console.error(`\n交易被拒絕：${hash}`);
  process.exit(1);
}
console.log(`\n已提交第 ${epoch} 期，交易 ${hash}`);
