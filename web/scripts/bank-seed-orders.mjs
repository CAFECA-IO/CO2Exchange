#!/usr/bin/env node
/**
 * 把鏈上的 Bank 事件與一組示範委託單寫進委託單 log。
 *
 *   cd web && npm run bank:seed
 *
 * B 期的餘額來自**重播 log**，不是直接讀鏈上餘額。所以 log 裡必須同時有：
 *   · 外部事件（存入、註銷、提領）—— 鏡像自鏈上，重播時才知道錢從哪來
 *   · 使用者的意思表示（掛單、撤單）—— 鏈下發生的部分
 *
 * 正式運作時，外部事件由一支常駐的索引器在看到鏈上事件時寫進 log，
 * 委託單由 `/api/bank/orders` 寫進去。這支腳本把那兩件事在本機一次做完，
 * 讓整條路（log → 重播 → 承諾 → 驗證）可以被跑起來看。
 *
 * ⚠️ 只在本機鏈用。它會直接寫 log 檔，而正式環境寫 log 的唯一入口是收單 API。
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, defineChain, http, keccak256, encodeAbiParameters } from "viem";

const { BANK_EVENTS } = await import("../lib/bank/ledger-core.ts");
const { chainHash, eventHash, GENESIS } = await import("../lib/bank/log.ts");

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:28545";
const pub0 = createPublicClient({ transport: http(RPC) });
const chainId = await pub0.getChainId();
if (chainId !== 31337 && chainId !== 1337) {
  console.error(`chainId ${chainId} 不是本機鏈。這支腳本會直接寫 log 檔，正式環境不該這樣做。`);
  process.exit(1);
}
const chain = defineChain({
  id: chainId, name: "co2x",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const client = createPublicClient({ chain, transport: http(RPC) });
const D = JSON.parse(fs.readFileSync(
  process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`), "utf8"));

const DIR = process.env.ORDERLOG_DIR ?? path.resolve(process.cwd(), "data", "orderlog");
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const fromBlock = BigInt(D.deployedAtBlock ?? 0);
const toBlock = await client.getBlockNumber();
const range = { address: D.bank, fromBlock, toBlock };

const [deposits, cashDeposits, retires] = await Promise.all([
  client.getLogs({ ...range, event: BANK_EVENTS.deposited }),
  client.getLogs({ ...range, event: BANK_EVENTS.cashDeposited }),
  client.getLogs({ ...range, event: BANK_EVENTS.retiredFor }),
]);

// 依區塊與 logIndex 排序：外部事件在 log 裡的順序必須是**鏈上的順序**，
// 不是我們讀到的順序。這是重播能重現的前提。
const external = [
  ...deposits.map((l) => ({ kind: "deposit", l })),
  ...cashDeposits.map((l) => ({ kind: "cashDeposit", l })),
  ...retires.map((l) => ({ kind: "retire", l })),
].sort((a, b) =>
  a.l.blockNumber !== b.l.blockNumber
    ? (a.l.blockNumber < b.l.blockNumber ? -1 : 1)
    : a.l.logIndex - b.l.logIndex);

const blockTimes = new Map();
async function timeOf(bn) {
  if (!blockTimes.has(bn)) blockTimes.set(bn, (await client.getBlock({ blockNumber: bn })).timestamp);
  return blockTimes.get(bn);
}

let seq = 0n;
let running = GENESIS;
const lines = [];
const replacer = (_k, v) => (typeof v === "bigint" ? `${v}n` : v);

function push(e) {
  const full = { ...e, seq: ++seq };
  running = chainHash(running, full);
  lines.push(JSON.stringify(full, replacer));
  return full;
}

// 手續費率先進 log。重播的人不必去猜當時的費率——猜錯就是餘額差幾個最小單位，
// 而那足以讓 root 對不上。
push({ kind: "config", at: (await timeOf(fromBlock + 1n)) ?? 0n, feeBps: 100n });

for (const { kind, l } of external) {
  const at = await timeOf(l.blockNumber);
  const ref = { txHash: l.transactionHash, block: l.blockNumber, logIndex: l.logIndex };
  if (kind === "cashDeposit") push({ kind, at, ref, account: l.args.account, amount: l.args.amount });
  else push({ kind, at, ref, account: l.args.account, batchId: l.args.batchId, amountKg: l.args.amountKg });
}

// 示範委託單。簽章這裡放佔位值——B 期的重點是「log → 重播 → 承諾 → 驗證」
// 這條路能不能走通；把 WebAuthn 簽章接進來是下一步（見 README 的「還沒做的」）。
// 佔位值仍然進雜湊，所以換掉它就會換掉 root，這是對的。
const holders = new Map();
for (const { kind, l } of external) {
  if (kind !== "deposit") continue;
  const a = l.args.account.toLowerCase();
  holders.set(a, { account: l.args.account, batchId: l.args.batchId, kg: (holders.get(a)?.kg ?? 0n) + l.args.amountKg });
}
const cashy = [...new Set(cashDeposits.map((l) => l.args.account.toLowerCase()))];

const now = await timeOf(toBlock);
const sig = keccak256(encodeAbiParameters([{ type: "string" }], ["demo-signature"]));
let nonce = new Map();
const next = (a) => { const n = (nonce.get(a) ?? 0n) + 1n; nonce.set(a, n); return n; };

let placed = 0;
for (const h of holders.values()) {
  if (h.kg < 1000n) continue;
  push({
    kind: "place", at: now, account: h.account, side: "sell", batchId: h.batchId, country: "TW",
    amountKg: h.kg / 2n, pricePerTonne: 800_000_000n, minFillKg: 0n,
    expiry: now + 30n * 86400n, nonce: next(h.account.toLowerCase()), signature: sig,
  });
  placed += 1;
}
for (const a of cashy) {
  // 買別人的貨。引擎會擋自成交（洗量），所以拿自己掛的單當對手方是測不到成交的——
  // 第一版的這支腳本就是這樣，跑出來 0 筆成交，看起來像撮合壞了。
  const seller = [...holders.values()].find((h) => h.account.toLowerCase() !== a);
  if (!seller) continue;
  push({
    kind: "place", at: now + 1n, account: a, side: "buy", batchId: seller.batchId, country: "TW",
    amountKg: 500n, pricePerTonne: 850_000_000n, minFillKg: 0n,
    expiry: now + 30n * 86400n, nonce: next(a), signature: sig,
  });
  placed += 1;
}

fs.writeFileSync(path.join(DIR, "events.jsonl"), `${lines.join("\n")}\n`);
fs.writeFileSync(path.join(DIR, "head.json"),
  JSON.stringify({ seq: String(seq), runningHash: running, updatedAt: new Date().toISOString() }, null, 2));

console.log(`委託單 log → ${DIR}`);
console.log(`  外部事件 ${external.length} 筆、委託單 ${placed} 筆，共 ${seq} 筆`);
console.log(`  事件鏈 head ${running}`);
console.log(`  最後一筆 ${eventHash(JSON.parse(lines[lines.length - 1], (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)))}`);
