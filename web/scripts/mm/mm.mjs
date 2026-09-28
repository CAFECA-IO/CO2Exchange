#!/usr/bin/env node
// 後台做市常駐程式。
//
//   cd web && npm run mm            # 前景跑（Ctrl-C 結束）；正式請用 launchd／systemd，見 README
//   npm run mm -- --once            # 只跑一輪就結束（檢查設定用）
//
// 它做什麼：
//   · 讀 web/data/mm/config.json（由 /admin「做市」頁寫入）；網站**不持有**做市金鑰，
//     只寫設定、讀狀態。金鑰在 repo 根目錄的 .mm.env（第一次跑時產生，權限 600）。
//   · 做市帳戶只被動報價：在參考價兩側掛買單與賣單，等別人來成交；絕不主動吃單，
//     絕不與平台控制的帳戶成交（見 strategy.mjs 開頭）。
//   · 風控：撥款上限、持有部位上限、單筆上限、報價上下限、單日停損。碰到停損就撤掉所有
//     報價並停下來，等人按「恢復」。
//   · 模擬模式（只在 SIMULATION_CHAINS 列出的測試鏈上可以開）：另起一個模擬器子行程，
//     讓虛擬人物互相交易。模擬器看不見做市帳戶的單，兩者不會互相成交。
//   · 每輪把狀態寫進 web/data/mm/status.json，做市帳戶地址寫進 accounts.json（公開揭露用）。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, toBytes, toHex } from "viem";
import { english, generateMnemonic, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { KeyError, keyring, parseEnvFile, setting } from "../lib/keys.mjs";
import {
  UNIT, bestExternal, equityOf, normalizeConfig, planRequote, platformSet,
  referencePrice, riskCheck, spreadWarnings, targetQuotes, taipeiDay,
} from "./strategy.mjs";

const ONCE = process.argv.includes("--once");
const DATA = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
const DIR = path.join(DATA, "mm");
const F = {
  config: path.join(DIR, "config.json"),
  status: path.join(DIR, "status.json"),
  state: path.join(DIR, "state.json"),
  accounts: path.join(DIR, "accounts.json"),
  simLog: path.join(DIR, "simulation.log"),
};
const KEY_FILE = process.env.MM_KEY_FILE ?? path.resolve(process.cwd(), "..", ".mm.env");
const MAX_TX_PER_TICK = Number(process.env.MM_MAX_TX ?? 30);
const SCAN = Number(process.env.MM_SCAN ?? 300);
const LOOKBACK_BLOCKS = BigInt(process.env.MM_LOOKBACK_BLOCKS ?? 20000);

// ───────────────────────── 小工具 ─────────────────────────

const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace("T", " "), ...a);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
/// 先寫暫存檔再改名：網站隨時可能在讀，不能讓它讀到寫到一半的檔案。
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
  fs.renameSync(tmp, f);
}
const twd = (u) => Number(u) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recent = [];
const note = (msg) => { log(msg); recent.unshift({ at: new Date().toISOString(), msg }); recent.length = Math.min(recent.length, 30); };

// ───────────────────────── 鏈與部署 ─────────────────────────

const RPC = setting("RPC_URL") ?? "http://127.0.0.1:28545";
const pub0 = createPublicClient({ transport: http(RPC) });
const chainId = await pub0.getChainId().catch(() => { console.error(`連不上 ${RPC}`); process.exit(1); });
const LOCAL = chainId === 31337 || chainId === 1337;
const chain = defineChain({ id: chainId, name: "co2x", nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: LOCAL ? 50 : 1000 });
const depFile = process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`);
if (!fs.existsSync(depFile)) { console.error(`找不到部署檔 ${depFile}`); process.exit(1); }
const D = JSON.parse(fs.readFileSync(depFile, "utf8"));
const DEPLOYMENT_KEY = `${chainId}:${D.listing}:${D.deployedAt ?? ""}`.toLowerCase();

/// 模擬交易只准在這些鏈上開。正式鏈不在清單裡，後台按了也不會啟動——
/// 不是介面藏起來，是這支程式拒絕。
const SIM_CHAINS = new Set(String(setting("SIMULATION_CHAINS") ?? "31337,1337,8018").split(",").map((x) => Number(x.trim())).filter(Boolean));
const SIM_ALLOWED = SIM_CHAINS.has(chainId);

// ───────────────────────── 金鑰 ─────────────────────────

let op, identitySigner;
try {
  const ring = keyring({ chainId, isLocal: LOCAL });
  for (const n of ring.notes) log(n);
  op = privateKeyToAccount(ring.require("DEPLOYER_PK", "RELAYER_PK").pk);
  identitySigner = privateKeyToAccount(ring.optional({ pk: ring.require("DEPLOYER_PK", "RELAYER_PK").pk }, "IDENTITY_VERIFIER_PK").pk);
} catch (e) {
  if (e instanceof KeyError) { console.error(`\n${e.message}`); process.exit(1); }
  throw e;
}

/// 做市帳戶的金鑰不放 web/.env.local：那個檔是網站執行期讀的，而網站不需要、也不該能替做市帳戶簽字。
function mmMnemonic() {
  const cur = parseEnvFile(KEY_FILE).MM_MNEMONIC;
  if (cur) return cur;
  const m = generateMnemonic(english);
  fs.writeFileSync(KEY_FILE, `# 後台做市帳戶的助記詞。網站不讀這個檔；不要貼到任何地方。\nMM_MNEMONIC=${m}\n`, { mode: 0o600 });
  log(`已產生做市帳戶的助記詞，寫在 ${KEY_FILE}（權限 600，不會印出來）`);
  return m;
}
const mm = mnemonicToAccount(mmMnemonic(), { addressIndex: 0 });
const mmClient = createWalletClient({ account: mm, chain, transport: http(RPC) });
const opClient = createWalletClient({ account: op, chain, transport: http(RPC) });

// ───────────────────────── ABI ─────────────────────────

const listingAbi = parseAbi([
  "struct Order { address seller; uint256 batchId; uint256 remainingKg; uint256 pricePerTonne; uint256 minFillKg; bool active; }",
  "struct Bid { address buyer; bytes2 country; uint256 remainingKg; uint256 pricePerTonne; uint256 minFillKg; bool active; uint256 escrow; }",
  "function list(uint256 batchId, uint256 amountKg, uint256 pricePerTonne, uint256 minFillKg) returns (uint256)",
  "function cancel(uint256 orderId)",
  "function placeBid(bytes2 country, uint256 amountKg, uint256 pricePerTonne, uint256 minFillKg) returns (uint256)",
  "function cancelBid(uint256 bidId)",
  "function orderOf(uint256) view returns (Order)",
  "function bidOf(uint256) view returns (Bid)",
  "function nextOrderId() view returns (uint256)",
  "function nextBidId() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "event Filled(uint256 indexed orderId, address indexed buyer, uint256 amountKg, uint256 cost, uint256 fee)",
  "event BidFilled(uint256 indexed bidId, address indexed seller, uint256 indexed batchId, uint256 amountKg, uint256 cost, uint256 fee)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function mint(address, uint256)",
]);
const creditAbi = parseAbi([
  "function heldBatches(address) view returns (uint256[])",
  "function balanceOf(address, uint256) view returns (uint256)",
  "function isApprovedForAll(address, address) view returns (bool)",
  "function setApprovalForAll(address, bool)",
]);
const kycAbi = parseAbi([
  "struct IdentityAttestation { address account; uint8 tier; uint64 expiry; bytes2 jurisdiction; bytes32 identityHash; uint256 nonce; uint256 deadline; }",
  "function register(IdentityAttestation a, bytes signature)",
  "function nonces(address) view returns (uint256)",
  "function isActive(address) view returns (bool)",
]);

// ───────────────────────── 送交易 ─────────────────────────

let txThisTick = 0;
/// 每筆都問鏈上的 pending nonce：營運金鑰同時被模擬器用著，本地計數一定會落後。
async function send(client, account, params, label) {
  if (txThisTick >= MAX_TX_PER_TICK) throw new Error(`本輪已送 ${MAX_TX_PER_TICK} 筆，剩下的留到下一輪`);
  const { request, result } = await pub.simulateContract({ ...params, account });
  const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  const hash = await client.writeContract({ ...request, nonce });
  txThisTick += 1;
  const rc = await pub.waitForTransactionReceipt({ hash, retryCount: 5 });
  if (rc.status !== "success") throw new Error(`${label} 交易失敗 ${hash}`);
  return result;
}
async function sendValue(to, value) {
  const nonce = await pub.getTransactionCount({ address: op.address, blockTag: "pending" });
  const hash = await opClient.sendTransaction({ to, value, nonce });
  await pub.waitForTransactionReceipt({ hash, retryCount: 5 });
}

// ───────────────────────── 帳戶準備 ─────────────────────────

const GAS_PRICE = await pub.getGasPrice().catch(() => 0n);
const GAS_TOPUP = (() => { const a = BigInt(process.env.MM_GAS_TOPUP ?? (LOCAL ? 10n ** 19n : 10n ** 16n)), b = GAS_PRICE * 10_000_000n; return a > b ? a : b; })();
const GAS_FLOOR = GAS_TOPUP / 4n;

async function ensureGas() {
  const bal = await pub.getBalance({ address: mm.address });
  if (bal >= GAS_FLOOR) return bal;
  if (LOCAL) {
    await pub.request({ method: "anvil_setBalance", params: [mm.address, toHex(GAS_TOPUP)] }).catch(() => sendValue(mm.address, GAS_TOPUP));
  } else {
    await sendValue(mm.address, GAS_TOPUP);
  }
  note(`撥 gas 給做市帳戶 ${Number(GAS_TOPUP) / 1e18}`);
  return pub.getBalance({ address: mm.address });
}

let onboarded = false;
/// 做市帳戶也要通過身分登錄（Listing 只跟有效帳戶打交道）。登錄成「法人」，身分雜湊
/// 標明是平台做市帳戶——這一筆 attestation 在鏈上公開，任何人都查得到它是誰。
async function onboard() {
  if (onboarded) return;
  await ensureGas();
  const active = await pub.readContract({ address: D.kycRegistry, abi: kycAbi, functionName: "isActive", args: [mm.address] });
  if (!active) {
    const now = Number((await pub.getBlock()).timestamp);
    const a = {
      account: mm.address, tier: 2, expiry: BigInt(now + 365 * 86400),
      jurisdiction: toHex(Buffer.from("TW", "utf8")),
      identityHash: keccak256(toBytes(`CO2X-PLATFORM-MARKET-MAKER-v1:${mm.address.toLowerCase()}`)),
      nonce: await pub.readContract({ address: D.kycRegistry, abi: kycAbi, functionName: "nonces", args: [mm.address] }),
      deadline: BigInt(now + 3600),
    };
    const signature = await identitySigner.signTypedData({
      domain: { name: "CO2Exchange KYCRegistry", version: "1", chainId, verifyingContract: D.kycRegistry },
      types: { IdentityAttestation: [
        { name: "account", type: "address" }, { name: "tier", type: "uint8" }, { name: "expiry", type: "uint64" },
        { name: "jurisdiction", type: "bytes2" }, { name: "identityHash", type: "bytes32" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ] },
      primaryType: "IdentityAttestation", message: a,
    });
    await send(mmClient, mm, { address: D.kycRegistry, abi: kycAbi, functionName: "register", args: [a, signature] }, "身分登錄");
    note(`做市帳戶 ${mm.address} 完成身分登錄（法人）`);
  }
  const allowance = await pub.readContract({ address: D.settlementToken, abi: erc20Abi, functionName: "allowance", args: [mm.address, D.listing] });
  if (allowance < 2n ** 200n) await send(mmClient, mm, { address: D.settlementToken, abi: erc20Abi, functionName: "approve", args: [D.listing, 2n ** 255n] }, "授權結算幣");
  const approved = await pub.readContract({ address: D.carbonCredit1155, abi: creditAbi, functionName: "isApprovedForAll", args: [mm.address, D.listing] });
  if (!approved) await send(mmClient, mm, { address: D.carbonCredit1155, abi: creditAbi, functionName: "setApprovalForAll", args: [D.listing, true] }, "授權額度");
  onboarded = true;
}

// ───────────────────────── 讀市場 ─────────────────────────

async function chunked(ids, fn, size = 20) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await Promise.all(ids.slice(i, i + size).map(fn))));
  return out;
}

async function readBook() {
  const [nextOrder, nextBid] = await Promise.all([
    pub.readContract({ address: D.listing, abi: listingAbi, functionName: "nextOrderId" }),
    pub.readContract({ address: D.listing, abi: listingAbi, functionName: "nextBidId" }).catch(() => 1n),
  ]);
  const range = (next) => { const hi = Number(next), lo = Math.max(1, hi - SCAN); return Array.from({ length: Math.max(0, hi - lo) }, (_, i) => lo + i); };
  const orders = (await chunked(range(nextOrder), async (id) => ({ id, o: await pub.readContract({ address: D.listing, abi: listingAbi, functionName: "orderOf", args: [BigInt(id)] }) })))
    .filter(({ o }) => o.active && o.remainingKg > 0n)
    .map(({ id, o }) => ({ id, seller: o.seller, batchId: Number(o.batchId), remainingKg: Number(o.remainingKg), price: o.pricePerTonne }));
  const bids = (await chunked(range(nextBid), async (id) => ({ id, b: await pub.readContract({ address: D.listing, abi: listingAbi, functionName: "bidOf", args: [BigInt(id)] }) })))
    .filter(({ b }) => b.active && b.remainingKg > 0n)
    .map(({ id, b }) => ({ id, buyer: b.buyer, remainingKg: Number(b.remainingKg), price: b.pricePerTonne, escrow: b.escrow }));
  return { orders, bids };
}

async function readTrades() {
  const head = await pub.getBlockNumber();
  const start = BigInt(D.deployedAtBlock ?? 0);
  const fromBlock = head > LOOKBACK_BLOCKS && head - LOOKBACK_BLOCKS > start ? head - LOOKBACK_BLOCKS : start;
  const ev = listingAbi.filter((x) => x.type === "event");
  const logs = await pub.getLogs({ address: D.listing, events: ev, fromBlock, toBlock: head }).catch(() => []);
  return logs
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)))
    .map((l) => ({ kg: Number(l.args.amountKg), price: (l.args.cost * 1000n) / (l.args.amountKg || 1n) }))
    .filter((t) => t.kg > 0);
}

async function readHoldings(addr) {
  const ids = await pub.readContract({ address: D.carbonCredit1155, abi: creditAbi, functionName: "heldBatches", args: [addr] });
  const rows = await chunked([...ids], async (id) => ({ batchId: Number(id), kg: Number(await pub.readContract({ address: D.carbonCredit1155, abi: creditAbi, functionName: "balanceOf", args: [addr, id] })) }));
  return rows.filter((r) => r.kg > 0).sort((a, b) => b.kg - a.kg || a.batchId - b.batchId);
}

const cashOf = (a) => pub.readContract({ address: D.settlementToken, abi: erc20Abi, functionName: "balanceOf", args: [a] });

function simulatedAddresses() {
  const r = readJson(path.join(DATA, "sim-personas.json"), null);
  return [...(r?.personas ?? []).map((p) => p.address), ...(r?.addressSpace ?? [])].filter(Boolean);
}

// ───────────────────────── 狀態 ─────────────────────────

function loadState() {
  const s = readJson(F.state, null);
  if (s && s.deploymentKey === DEPLOYMENT_KEY) return s;
  if (s) note("部署換了，做市狀態從頭開始（舊部署的撥款紀錄不適用新合約）");
  return { deploymentKey: DEPLOYMENT_KEY, fundedTotal: "0", day: null, dayStartNet: null, halted: null, cmd: { recall: 0, resume: 0 } };
}
const saveState = (s) => writeJson(F.state, s);

function readConfig() {
  if (!fs.existsSync(F.config)) {
    const { config } = normalizeConfig({});
    writeJson(F.config, { ...config, updatedAt: new Date().toISOString(), updatedBy: "mm（預設值）" });
  }
  return normalizeConfig(readJson(F.config, {}));
}

// ───────────────────────── 模擬子行程 ─────────────────────────

let sim = null, simWantedSince = 0, simRestartAt = 0, simExit = null;
function manageSimulation(cfg) {
  const want = cfg.simulation.enabled && SIM_ALLOWED;
  if (!want && sim) { note("停止模擬交易"); sim.kill("SIGINT"); sim = null; return; }
  if (!want || sim || Date.now() < simRestartAt) return;
  const args = ["scripts/simulate.mjs", "--users", String(cfg.simulation.users), "--interval", String(cfg.simulation.intervalSec), "--quiet", "--avoid", mm.address];
  const out = fs.openSync(F.simLog, "a");
  try { if (fs.statSync(F.simLog).size > 5e6) fs.truncateSync(F.simLog, 0); } catch { /* 沒有就算了 */ }
  sim = spawn(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, RPC_URL: RPC }, stdio: ["ignore", out, out] });
  simWantedSince = Date.now();
  note(`啟動模擬交易（${cfg.simulation.users} 人，每 ${cfg.simulation.intervalSec} 秒一輪；紀錄在 data/mm/simulation.log）`);
  sim.on("exit", (code) => {
    simExit = { code, at: new Date().toISOString() };
    sim = null;
    // 很快就死掉通常是設定錯（金鑰、部署），不要每秒重啟一次把 log 灌爆
    const quick = Date.now() - simWantedSince < 60_000;
    simRestartAt = Date.now() + (quick ? 5 * 60_000 : 30_000);
    note(`模擬器結束（exit ${code}），${quick ? "5 分鐘" : "30 秒"}後重啟`);
  });
}

// ───────────────────────── 一輪 ─────────────────────────

async function cancelAll(mine, why) {
  let n = 0;
  for (const o of mine.orders) { await send(mmClient, mm, { address: D.listing, abi: listingAbi, functionName: "cancel", args: [BigInt(o.id)] }, "撤賣單"); n += 1; }
  for (const b of mine.bids) { await send(mmClient, mm, { address: D.listing, abi: listingAbi, functionName: "cancelBid", args: [BigInt(b.id)] }, "撤買單"); n += 1; }
  if (n) note(`撤掉 ${n} 張報價（${why}）`);
}

async function tick() {
  txThisTick = 0;
  const { config: cfg, problems } = readConfig();
  const state = loadState();
  let simulation = { allowed: SIM_ALLOWED, requested: cfg.simulation.enabled, running: !!sim, lastExit: simExit };

  if (!ONCE) manageSimulation(cfg); // --once 是檢查用，不留下背景行程
  simulation = { ...simulation, running: !!sim };

  const book = await readBook();
  const platform = platformSet([mm.address, op.address, D.treasury], simulatedAddresses());
  const mine = {
    orders: book.orders.filter((o) => o.seller.toLowerCase() === mm.address.toLowerCase()),
    bids: book.bids.filter((b) => b.buyer.toLowerCase() === mm.address.toLowerCase()),
  };

  // ── 一次性指令 ──
  if (cfg.commands.resume > (state.cmd?.resume ?? 0)) {
    state.cmd = { ...state.cmd, resume: cfg.commands.resume };
    if (state.halted) note(`恢復報價（先前停止原因：${state.halted.reason}）`);
    state.halted = null; state.dayStartNet = null;
  }
  if (cfg.commands.recall > (state.cmd?.recall ?? 0)) {
    state.cmd = { ...state.cmd, recall: cfg.commands.recall };
    await cancelAll(mine, "收回資金");
    mine.orders = []; mine.bids = [];
    const bal = await cashOf(mm.address);
    if (bal > 0n) {
      await ensureGas();
      await send(mmClient, mm, { address: D.settlementToken, abi: erc20Abi, functionName: "transfer", args: [op.address, bal] }, "收回資金");
    }
    const funded = BigInt(state.fundedTotal);
    state.fundedTotal = (funded > bal ? funded - bal : 0n).toString();
    state.halted = { reason: `資金已收回（${twd(bal)} 元回到營運金鑰）。按「恢復」後會依撥款上限重新撥款`, at: new Date().toISOString() };
    note(`收回資金 ${twd(bal)} 元`);
  }

  // ── 部位與參考價 ──
  const [cash, holdings, trades] = await Promise.all([cashOf(mm.address), readHoldings(mm.address), readTrades()]);
  const freeKg = holdings.reduce((s, h) => s + h.kg, 0);
  const listedKg = mine.orders.reduce((s, o) => s + o.remainingKg, 0);
  const bidEscrow = mine.bids.reduce((s, b) => s + b.escrow, 0n);
  const inventoryKg = freeKg + listedKg;
  const ext = bestExternal({ orders: book.orders, bids: book.bids, platform });
  // 交叉防護看的是**除了自己以外的所有單**（含模擬人物的）：參考價不能拿平台自己的單來算，
  // 但簿子上不管是誰的單，買價高過賣價就是一本壞掉的簿子。
  const cross = bestExternal({ orders: book.orders, bids: book.bids, platform: platformSet([mm.address]) });
  const ref = referencePrice({ trades, bestBid: ext.bestBid, bestAsk: ext.bestAsk, config: cfg });
  const equity = equityOf({ cash, bidEscrow, inventoryKg, ref: ref.price });
  // 損益一律扣掉撥款：撥進來的錢不是賺的，收回去的錢也不是賠的。
  const net = equity - BigInt(state.fundedTotal);
  const now = Math.floor(Date.now() / 1000);
  const day = taipeiDay(now);
  if (state.day !== day || state.dayStartNet == null) { state.day = day; state.dayStartNet = net.toString(); }
  const risk = riskCheck({ equity: net, dayStartEquity: BigInt(state.dayStartNet), config: cfg });
  if (risk.halt && !state.halted) {
    state.halted = { reason: risk.reason, at: new Date().toISOString() };
    note(`停損：${risk.reason}`);
  }

  const feeBps = Number(await pub.readContract({ address: D.listing, abi: listingAbi, functionName: "feeBps" }).catch(() => 0n));
  const warnings = [...problems, ...spreadWarnings(cfg, feeBps)];
  if (cfg.simulation.enabled && !SIM_ALLOWED) warnings.push(`chainId ${chainId} 不在 SIMULATION_CHAINS（${[...SIM_CHAINS].join(",")}），模擬交易不會啟動`);
  const funded = BigInt(state.fundedTotal);
  const cap = BigInt(cfg.capitalTWD) * UNIT;
  if (funded > cap) warnings.push(`已撥款 ${twd(funded)} 元超過目前上限 ${cfg.capitalTWD} 元：不會自動收回，要收回請按「收回資金」`);

  let action = "idle";
  if (!cfg.enabled || state.halted) {
    if (mine.orders.length || mine.bids.length) await cancelAll(mine, state.halted ? "已停止" : "做市已關閉");
    mine.orders = []; mine.bids = [];
    action = state.halted ? "halted" : "disabled";
  } else {
    await onboard();
    await ensureGas();

    // ── 撥款：只補到上限為止。虧掉的不會自動補——那會讓停損失去意義 ──
    if (funded < cap) {
      const want = cap - funded;
      let given = 0n;
      if (D.settlementMintable !== false) {
        await send(opClient, op, { address: D.settlementToken, abi: erc20Abi, functionName: "mint", args: [mm.address, want] }, "撥款（鑄造）");
        given = want;
      } else {
        const have = await cashOf(op.address);
        given = have < want ? have : want;
        if (given > 0n) await send(opClient, op, { address: D.settlementToken, abi: erc20Abi, functionName: "transfer", args: [mm.address, given] }, "撥款");
        if (given < want) warnings.push(`營運金鑰 ${op.address} 的結算幣不夠：還差 ${twd(want - given)} 元沒有撥到做市帳戶`);
      }
      if (given > 0n) { state.fundedTotal = (funded + given).toString(); note(`撥款 ${twd(given)} 元給做市帳戶`); }
    }

    // ── 報價 ──
    const cashNow = await cashOf(mm.address);
    const target = targetQuotes({
      ref: ref.price, config: cfg, inventoryKg,
      freeInventoryKg: freeKg + listedKg, cash: cashNow + bidEscrow,
      bestExternalBid: cross.bestBid, bestExternalAsk: cross.bestAsk,
    });
    const bidPlan = planRequote({ current: mine.bids, target: target.bids, requoteBps: cfg.requoteBps });
    const askPlan = planRequote({ current: mine.orders, target: target.asks, requoteBps: cfg.requoteBps });

    for (const b of bidPlan.cancel) await send(mmClient, mm, { address: D.listing, abi: listingAbi, functionName: "cancelBid", args: [BigInt(b.id)] }, "撤買單");
    for (const o of askPlan.cancel) await send(mmClient, mm, { address: D.listing, abi: listingAbi, functionName: "cancel", args: [BigInt(o.id)] }, "撤賣單");

    for (const q of bidPlan.place) {
      await send(mmClient, mm, { address: D.listing, abi: listingAbi, functionName: "placeBid", args: ["0x0000", BigInt(q.kg), q.price, BigInt(target.minFillKg)] }, "掛買單");
    }
    // 賣單要指定批次：撤單之後重讀持有，從持有最多的批次開始分配
    const free = askPlan.place.length ? await readHoldings(mm.address) : [];
    for (const q of askPlan.place) {
      let left = q.kg;
      for (const h of free) {
        if (left <= 0) break;
        const kg = Math.min(left, h.kg);
        if (kg < target.minFillKg) continue;
        try {
          await send(mmClient, mm, { address: D.listing, abi: listingAbi, functionName: "list", args: [BigInt(h.batchId), BigInt(kg), q.price, BigInt(target.minFillKg)] }, "掛賣單");
          h.kg -= kg; left -= kg;
        } catch (e) {
          // 轄區被關掉的批次不能上架；換下一批，不要整輪停住
          note(`批次 #${h.batchId} 無法上架：${String(e.shortMessage ?? e.message).slice(0, 80)}`);
          h.kg = 0;
        }
      }
    }
    const changed = bidPlan.cancel.length + askPlan.cancel.length + bidPlan.place.length + askPlan.place.length;
    action = changed ? `requoted:${changed}` : "quoting";
  }

  // ── 狀態 ──
  const after = await readBook();
  const myOrders = after.orders.filter((o) => o.seller.toLowerCase() === mm.address.toLowerCase());
  const myBids = after.bids.filter((b) => b.buyer.toLowerCase() === mm.address.toLowerCase());
  const [cashEnd, holdEnd, gas] = await Promise.all([cashOf(mm.address), readHoldings(mm.address), pub.getBalance({ address: mm.address })]);
  const escrowEnd = myBids.reduce((s, b) => s + b.escrow, 0n);
  const invEnd = holdEnd.reduce((s, h) => s + h.kg, 0) + myOrders.reduce((s, o) => s + o.remainingKg, 0);
  const equityEnd = equityOf({ cash: cashEnd, bidEscrow: escrowEnd, inventoryKg: invEnd, ref: ref.price });
  saveState(state);
  writeJson(F.status, {
    heartbeatAt: new Date().toISOString(), pid: process.pid, chainId, rpc: RPC.replace(/\/\/[^@]*@/, "//"),
    intervalSec: cfg.intervalSec, action, halted: state.halted,
    marketMaker: mm.address, operator: op.address,
    ref: { pricePerTonne: twd(ref.price), source: ref.source },
    cash: twd(cashEnd), bidEscrow: twd(escrowEnd), inventoryKg: invEnd, freeInventoryKg: holdEnd.reduce((s, h) => s + h.kg, 0),
    equity: twd(equityEnd),
    pnl: twd(equityEnd - BigInt(state.fundedTotal)),
    dayPnl: twd(equityEnd - BigInt(state.fundedTotal) - BigInt(state.dayStartNet)),
    fundedTotal: twd(BigInt(state.fundedTotal)), capitalTWD: cfg.capitalTWD, feeBps,
    gas: Number(gas) / 1e18,
    quotes: {
      bids: myBids.map((b) => ({ id: b.id, pricePerTonne: twd(b.price), kg: b.remainingKg })).sort((a, b) => b.pricePerTonne - a.pricePerTonne),
      asks: myOrders.map((o) => ({ id: o.id, pricePerTonne: twd(o.price), kg: o.remainingKg, batchId: o.batchId })).sort((a, b) => a.pricePerTonne - b.pricePerTonne),
    },
    externalBest: { bid: ext.bestBid === null ? null : twd(ext.bestBid), ask: ext.bestAsk === null ? null : twd(ext.bestAsk) },
    simulation: { ...simulation, running: !!sim, chains: [...SIM_CHAINS] },
    warnings, recent, txThisTick,
  });
  writeJson(F.accounts, {
    note: "平台做市帳戶。只被動報價，不與平台控制的帳戶成交。",
    chainId, marketMakers: [mm.address], platform: [op.address], simulationActive: !!sim,
    updatedAt: new Date().toISOString(),
  });
  return cfg;
}

// ───────────────────────── 主迴圈 ─────────────────────────

log(`後台做市啟動：chainId ${chainId}，做市帳戶 ${mm.address}，營運金鑰 ${op.address}`);
log(`  設定 ${F.config}；狀態 ${F.status}；模擬交易${SIM_ALLOWED ? "可以" : "不可以"}在這條鏈上開`);
let stop = false;
const onSignal = () => { stop = true; log("收到中斷，跑完這一輪就停"); if (sim) sim.kill("SIGINT"); };
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

while (!stop) {
  let interval = 60;
  try {
    const cfg = await tick();
    interval = cfg.intervalSec;
  } catch (e) {
    const msg = String(e.shortMessage ?? e.message).slice(0, 300);
    note(`本輪失敗：${msg}`);
    const prev = readJson(F.status, {});
    writeJson(F.status, { ...prev, heartbeatAt: new Date().toISOString(), pid: process.pid, lastError: { at: new Date().toISOString(), msg }, recent });
  }
  if (ONCE) break;
  for (let i = 0; i < interval && !stop; i++) await sleep(1000);
}
if (sim) sim.kill("SIGINT");
log("後台做市已停止");
