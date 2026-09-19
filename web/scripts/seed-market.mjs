#!/usr/bin/env node
/**
 * 逐筆買進 SeedMarket 掛出的單，並在每筆之間推進區塊時間，
 * 讓每筆成交落在不同時間戳上 —— 行情圖的 K 棒才有時間軸可分。
 *
 * 放在 web/ 底下是為了直接用得到 viem（唯一的相依）。
 * 前身是 script/seed-market.sh，那版每筆要開三個 cast 行程，
 * 一年份上千筆會慢到不能用；這版全程一個行程 + keep-alive 連線。
 *
 *   cd web
 *   npm run seed:market                      # 預設 72 筆 / 1.5 天
 *   npm run seed:market -- --days 365 --per-day 3
 *
 * 參數：
 *   --days N      這批成交要橫跨幾天（預設 1.5）
 *   --per-day N   每天幾筆（預設 48）
 *   --trades N    直接指定總筆數（會覆寫 per-day）
 *   --first N     起始 orderId（預設由 nextOrderId 往回推）
 *   --rpc URL     預設 $RPC_URL 或 http://127.0.0.1:8545
 *
 * ⚠️ 區塊時間只能往前走，不能倒退。要讓「一年份」結束在今天而不是明年，
 *    anvil 必須從一年前起算：
 *      anvil --timestamp $(( $(date +%s) - 365*86400 ))
 */
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import fs from "node:fs";
import path from "node:path";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const RPC = arg("rpc", process.env.RPC_URL ?? "http://127.0.0.1:8545");
const DAYS = Number(arg("days", 1.5));
const PER_DAY = Number(arg("per-day", 48));
const TRADES = Number(arg("trades", Math.max(1, Math.round(DAYS * PER_DAY))));
const MAX_LOT_KG = 2000n;

const PK_ALICE = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const PK_B = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const listingAbi = parseAbi([
  "function buy(uint256 orderId, uint256 amountKg)",
  "function nextOrderId() view returns (uint256)",
]);
const erc20Abi = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);

const pub0 = createPublicClient({ transport: http(RPC) });
const chainId = await pub0.getChainId();
const chain = defineChain({
  id: chainId,
  name: "seed",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });

const file = path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`);
if (!fs.existsSync(file)) {
  console.error(`找不到 ${file} —— 請先部署。`);
  process.exit(1);
}
const d = JSON.parse(fs.readFileSync(file, "utf8"));

const first = Number(arg("first", Number(await pub.readContract({ address: d.listing, abi: listingAbi, functionName: "nextOrderId" })) - TRADES));
if (first < 1) {
  console.error(`起始 orderId 算出來是 ${first} —— 掛單數不足 ${TRADES} 筆，請先跑 SEED_TRADES=${TRADES} 的 SeedMarket。`);
  process.exit(1);
}

const buyers = [PK_ALICE, PK_B].map((pk) => {
  const account = privateKeyToAccount(pk);
  return { account, client: createWalletClient({ account, chain, transport: http(RPC) }), nonce: 0 };
});
for (const b of buyers) b.nonce = await pub.getTransactionCount({ address: b.account.address });

const stepSeconds = Math.max(1, Math.round((DAYS * 86400) / TRADES));
let t = Number((await pub.getBlock({ blockTag: "latest" })).timestamp);
const endsAt = t + stepSeconds * TRADES;

console.log(`RPC        ${RPC}  (chainId ${chainId})`);
console.log(`Listing    ${d.listing}`);
console.log(`成交       ${TRADES} 筆，orderId ${first} 起，橫跨 ${DAYS} 天（每筆間隔 ${stepSeconds}s）`);
console.log(`時間區間   ${new Date(t * 1000).toISOString().slice(0, 16)} → ${new Date(endsAt * 1000).toISOString().slice(0, 16)}`);
if (endsAt > Date.now() / 1000 + 86400) {
  console.log(`\n⚠️  結束時間落在未來。要讓歷史結束在今天，anvil 請從 ${DAYS} 天前起算：`);
  console.log(`   anvil --timestamp $(( $(date +%s) - ${Math.round(DAYS * 86400)} ))\n`);
}

// 一次授權，之後每筆就不必再 approve
for (const b of buyers) {
  await b.client.writeContract({
    address: d.settlementToken,
    abi: erc20Abi,
    functionName: "approve",
    args: [d.listing, (1n << 256n) - 1n],
    nonce: b.nonce++,
  });
}

let ok = 0;
let fail = 0;
const started = Date.now();
for (let i = 0; i < TRADES; i++) {
  // 成交量做出高低差：每根 K 棒的量都一樣高，圖看起來就假了
  const lot = BigInt(400 + ((i * 617 + 191) % 1601));
  const b = buyers[i % 3 === 0 ? 1 : 0];

  t += stepSeconds;
  await pub.request({ method: "evm_setNextBlockTimestamp", params: [`0x${t.toString(16)}`] });

  try {
    await b.client.writeContract({
      address: d.listing,
      abi: listingAbi,
      functionName: "buy",
      args: [BigInt(first + i), lot > MAX_LOT_KG ? MAX_LOT_KG : lot],
      nonce: b.nonce++,
    });
    ok++;
  } catch (e) {
    fail++;
    b.nonce = await pub.getTransactionCount({ address: b.account.address });
    if (fail <= 3) console.warn(`\n  orderId ${first + i} 失敗：${String(e).split("\n")[0]}`);
  }

  if (i % 25 === 0 || i === TRADES - 1) {
    process.stdout.write(`\r  已成交 ${ok}/${TRADES}（失敗 ${fail}）`);
  }
}
console.log(`\n完成，耗時 ${((Date.now() - started) / 1000).toFixed(1)}s。重新整理首頁就會看到走勢。`);
