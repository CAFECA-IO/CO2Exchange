#!/usr/bin/env node
// 後台做市常駐程式（帳本 v2，設計 v4 第 5 期）。
//
//   cd web && npm run mm            # 前景跑（Ctrl-C 結束）；正式請用 launchd／systemd，見 README
//   npm run mm -- --once            # 只跑一輪就結束（檢查設定用）
//
// 它做什麼：
//   · 讀 web/data/mm/config.json（由 /admin「做市」頁寫入）；網站**不持有**做市金鑰，
//     只寫設定、讀狀態。金鑰在 repo 根目錄的 .mm.env（第一次跑時產生，權限 600）。
//   · 做市帳戶只被動報價：在參考價兩側掛買單與賣單，等別人來成交；絕不主動吃單，
//     絕不與平台控制的帳戶成交（見 strategy.mjs 開頭）。
//   · **報價是簽名委託單**：做市帳戶是一般 EOA，簽的是和使用者相同的 EIP-712（PlaceOrder／CancelOrder），
//     寫進鏈下帳本、由引擎撮合，查核時用同一條 ecrecover 驗。只有入金是鏈上交易（把結算幣存進帳本合約）。
//   · 風控：撥款上限、持有部位上限、單筆上限、報價上下限、單日停損。碰到停損就撤掉所有
//     報價並停下來，等人按「恢復」。
//   · 模擬模式（只在 SIMULATION_CHAINS 列出的測試鏈上可以開）：另起模擬器子行程（ledger-sim.mjs），
//     讓虛擬人物互相交易。兩邊在帳本的寫入鎖裡互相迴避（agent.wouldMatch），不會互相成交。
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

const { openStore } = await import("../../lib/ledger/store.ts");
const { createAgent, wouldMatch } = await import("../../lib/ledger/agent.ts");
const { readAuthorities, LEDGER_ABI } = await import("../../lib/ledger/chain.ts");
const { isActive, tradeBpsOf } = await import("../../lib/ledger/engine.ts");

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
/// 每輪最多寫幾筆帳本事件（撤單＋掛單）。事件很便宜，但一輪幾百筆代表策略或設定出了問題。
const MAX_EVENTS_PER_TICK = Number(process.env.MM_MAX_EVENTS ?? 60);
/// 報價的有效期限。每輪都會重新檢查，快到期的撤掉重掛——過期的單不會成交，但鎖住的錢要撤單才會退回。
const QUOTE_TTL = BigInt(process.env.MM_QUOTE_TTL ?? 3 * 86400);
/// 做市帳戶只報這個核發國的買價（參考價也只看這個國家的成交）。國外額度的行情差很多，混在一起報不出合理的價。
const COUNTRY = String(setting("MM_COUNTRY") ?? "TW").toUpperCase();

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
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const low = (a) => String(a).toLowerCase();
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
if (D.ledgerVersion !== 2) {
  // 舊的全合約部署（Listing）的做市版本已經移除（第 5 期）。要跑舊版請 checkout 1eceb80 之前的版本。
  console.error("這個部署不是帳本 v2（script/DeployLedger.s.sol）。做市程式只支援帳本版。");
  process.exit(1);
}
const DEPLOYMENT_KEY = `${chainId}:${D.ledger}:${D.deployedAt ?? ""}`.toLowerCase();

/// 模擬交易只准在這些鏈上開。正式鏈不在清單裡，後台按了也不會啟動——
/// 不是介面藏起來，是這支程式拒絕。
const SIM_CHAINS = new Set(String(setting("SIMULATION_CHAINS") ?? "31337,1337,8018").split(",").map((x) => Number(x.trim())).filter(Boolean));
const SIM_ALLOWED = SIM_CHAINS.has(chainId);

// ───────────────────────── 金鑰 ─────────────────────────

let op, identitySigner, receiptSigner;
try {
  const ring = keyring({ chainId, isLocal: LOCAL });
  for (const n of ring.notes) log(n);
  // 營運金鑰：撥款給做市帳戶（鑄造或轉帳）、代付 gas
  op = privateKeyToAccount(ring.require("DEPLOYER_PK", "RELAYER_PK").pk);
  // 身分驗證金鑰：替做市帳戶登記身分（帳本的 identity 事件，門檻 1 的單一金鑰）
  identitySigner = privateKeyToAccount(ring.require("IDENTITY_VERIFIER_PK").pk);
  // 收單金鑰：簽收據（和網站收單用同一把）
  receiptSigner = privateKeyToAccount(ring.require("RECEIPT_SIGNER_PK", "RELAYER_PK").pk);
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

// ───────────────────────── 帳本 ─────────────────────────

const store = openStore(process.env.LEDGER_DIR ?? path.join(DATA, "ledger"));
const domains = { chainId, ledger: D.ledger };
let authCache = null;
const authorities = async () => {
  if (authCache && Date.now() - authCache.at < 60_000) return authCache.value;
  const value = await readAuthorities(pub, D.ledger, { fromBlock: BigInt(D.deployedAtBlock ?? 0) });
  authCache = { at: Date.now(), value };
  return value;
};
const agent = createAgent({ store, client: pub, domains, receiptSigner, authorities, fromBlock: BigInt(D.deployedAtBlock ?? 0) });

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function mint(address, uint256)",
]);

// ───────────────────────── 鏈上交易（只有入金） ─────────────────────────

/// 每筆都問鏈上的 pending nonce：營運金鑰同時被模擬器用著，本地計數一定會落後。
async function send(client, account, params, label) {
  const { request } = await pub.simulateContract({ ...params, account });
  const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  const hash = await client.writeContract({ ...request, nonce });
  const rc = await pub.waitForTransactionReceipt({ hash, retryCount: 5 });
  if (rc.status !== "success") throw new Error(`${label} 交易失敗 ${hash}`);
  return hash;
}
async function sendValue(to, value) {
  const nonce = await pub.getTransactionCount({ address: op.address, blockTag: "pending" });
  const hash = await opClient.sendTransaction({ to, value, nonce });
  await pub.waitForTransactionReceipt({ hash, retryCount: 5 });
}

const GAS_PRICE = await pub.getGasPrice().catch(() => 0n);
// 做市帳戶只有入金要付 gas（approve＋depositCash），比舊版每張報價一筆交易少得多
const GAS_TOPUP = (() => { const a = BigInt(process.env.MM_GAS_TOPUP ?? (LOCAL ? 10n ** 19n : 10n ** 15n)), b = GAS_PRICE * 1_000_000n; return a > b ? a : b; })();
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

/// 撥款：營運金鑰把結算幣給做市帳戶（本站發行的 MockTWD 就鑄造），做市帳戶自己存進帳本合約，再鏡像進帳本。
/// 回傳實際撥了多少。
async function fund(want, warnings) {
  let given = 0n;
  if (D.settlementMintable === true) {
    await send(opClient, op, { address: D.settlementToken, abi: erc20Abi, functionName: "mint", args: [mm.address, want] }, "撥款（鑄造）");
    given = want;
  } else {
    const have = await wallet(op.address);
    given = have < want ? have : want;
    if (given > 0n) await send(opClient, op, { address: D.settlementToken, abi: erc20Abi, functionName: "transfer", args: [mm.address, given] }, "撥款");
    if (given < want) warnings.push(`營運金鑰 ${op.address} 的結算幣不夠：還差 ${twd(want - given)} 元沒有撥到做市帳戶`);
  }
  // 錢包裡的（包括上一次撥了但沒存成的）全部存進帳本合約
  const inWallet = await wallet(mm.address);
  if (inWallet > 0n) {
    await ensureGas();
    const allowance = await pub.readContract({ address: D.settlementToken, abi: erc20Abi, functionName: "allowance", args: [mm.address, D.ledger] });
    if (allowance < inWallet) await send(mmClient, mm, { address: D.settlementToken, abi: erc20Abi, functionName: "approve", args: [D.ledger, 2n ** 255n] }, "授權帳本合約");
    await send(mmClient, mm, { address: D.ledger, abi: LEDGER_ABI, functionName: "depositCash", args: [inWallet] }, "存入帳本合約");
    const n = await agent.mirror(D.ledger);
    note(`做市帳戶存入 ${twd(inWallet)} 元（鏡像 ${n} 筆）`);
  }
  return given;
}
const wallet = (a) => pub.readContract({ address: D.settlementToken, abi: erc20Abi, functionName: "balanceOf", args: [a] });

/// 做市帳戶的身分：登記成「法人」，身分雜湊標明是平台做市帳戶。這一筆 identity 事件在帳本公開層，
/// 任何人都查得到它是誰。
async function onboard() {
  const s = agent.state();
  if (isActive(s, mm.address, nowSec() + 86400n)) return;
  const cur = s.identities.get(low(mm.address));
  const t = nowSec();
  const r = await agent.authority(identitySigner, "identity", {
    account: mm.address, tier: 2, expiry: t + 365n * 86400n, jurisdiction: "TW",
    identityHash: keccak256(toBytes(`CO2X-PLATFORM-MARKET-MAKER-v1:${low(mm.address)}`)),
    nonce: cur?.attNonce ?? 0n, deadline: t + 3600n,
  });
  if (r.rejectedReason) throw new Error(`做市帳戶的身分登記被帳本規則拒絕：${r.rejectedReason}`);
  note(`做市帳戶 ${mm.address} 完成身分登記（法人，帳本第 ${r.event.seq} 筆）`);
}

// ───────────────────────── 讀市場（帳本狀態） ─────────────────────────

/// 簿子。`live` 只含還沒到期的單；做市帳戶自己的單另外全部列出（到期的也要撤，才拿得回鎖住的錢）。
function readBook(s) {
  const t = nowSec();
  const orders = [], bids = [], mineAll = [];
  for (const o of s.book.values()) {
    if (o.remainingKg === 0n) continue;
    if (low(o.account) === low(mm.address)) mineAll.push(o);
    if (o.expiry <= t) continue;
    if (o.side === "sell") orders.push({ id: Number(o.seq), seller: o.account, batchId: Number(o.batchId), country: o.country, remainingKg: Number(o.remainingKg), price: o.pricePerTonne, expiry: o.expiry });
    else bids.push({ id: Number(o.seq), buyer: o.account, country: o.country, batchId: Number(o.batchId), remainingKg: Number(o.remainingKg), price: o.pricePerTonne, escrow: o.locked, expiry: o.expiry });
  }
  return { orders, bids, mineAll };
}

/// 參考價用的成交：只看做市報價的那個核發國（國外額度的行情不一樣）
const readTrades = (s) => s.fills.filter((f) => f.country === COUNTRY).slice(-200)
  .map((f) => ({ kg: Number(f.amountKg), price: f.pricePerTonne })).filter((t) => t.kg > 0);

function readHoldings(s, addr) {
  return [...(s.credits.get(low(addr)) ?? new Map()).entries()]
    .map(([id, kg]) => ({ batchId: Number(id), kg: Number(kg), country: s.batches.get(id) ? (s.projects.get(String(s.batches.get(id).projectId))?.country ?? "") : "" }))
    .filter((h) => h.kg > 0).sort((a, b) => b.kg - a.kg || a.batchId - b.batchId);
}
const cashOf = (s, a) => s.cash.get(low(a)) ?? 0n;

function simulatedAddresses() {
  const r = readJson(path.join(DATA, "sim-personas.json"), null);
  return [...(r?.personas ?? []).map((p) => p.address), ...(r?.addressSpace ?? [])].filter(Boolean);
}

// ───────────────────────── 帳本事件 ─────────────────────────

let eventsThisTick = 0;
/// 掛單或撤單。guard 在寫入鎖裡用最新的狀態判斷：報價不能和任何別人的單交叉（不主動吃單、也就不會吃到平台自己的單）。
async function put(kind, body, label, guard) {
  if (eventsThisTick >= MAX_EVENTS_PER_TICK) throw new Error(`本輪已寫 ${MAX_EVENTS_PER_TICK} 筆，剩下的留到下一輪`);
  const r = await agent.user(mm, kind, body, { guard });
  if (!r) return null; // guard 擋下：簿子在這一瞬間變了，下一輪再算
  eventsThisTick += 1;
  if (r.rejectedReason) note(`${label}被帳本規則拒絕：${r.rejectedReason}`);
  if (r.fills.length) note(`⚠️ ${label}當場成交 ${r.fills.length} 筆——不應該發生（做市只被動報價），請檢查`);
  return r;
}
const cancel = (o, label) => put("cancel", { orderSeq: BigInt(o.id ?? o.seq) }, label);
/// 報價不和任何「不是做市帳戶自己的」單交叉
const passive = (q) => (s) => !wouldMatch(s, { ...q, account: mm.address }, nowSec(), () => true);

async function cancelAll(mineAll, why) {
  let n = 0;
  for (const o of mineAll) { if (await cancel(o, o.side === "sell" ? "撤賣單" : "撤買單")) n += 1; }
  if (n) note(`撤掉 ${n} 張報價（${why}）`);
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
  const args = ["--experimental-strip-types", "--no-warnings", "scripts/ledger-sim.mjs",
    "--users", String(cfg.simulation.users), "--interval", String(cfg.simulation.intervalSec), "--quiet", "--avoid", mm.address];
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

async function tick() {
  eventsThisTick = 0;
  const { config: cfg, problems } = readConfig();
  const state = loadState();
  let simulation = { allowed: SIM_ALLOWED, requested: cfg.simulation.enabled, running: !!sim, lastExit: simExit };

  if (!ONCE) manageSimulation(cfg); // --once 是檢查用，不留下背景行程
  simulation = { ...simulation, running: !!sim };

  let s = agent.state();
  let book = readBook(s);
  const platform = platformSet([mm.address, op.address, s.policy.treasury], simulatedAddresses());

  // ── 一次性指令 ──
  if (cfg.commands.resume > (state.cmd?.resume ?? 0)) {
    state.cmd = { ...state.cmd, resume: cfg.commands.resume };
    if (state.halted) note(`恢復報價（先前停止原因：${state.halted.reason}）`);
    state.halted = null; state.dayStartNet = null;
  }
  if (cfg.commands.recall > (state.cmd?.recall ?? 0)) {
    state.cmd = { ...state.cmd, recall: cfg.commands.recall };
    await cancelAll(book.mineAll, "收回資金");
    // 錢包裡還沒存進去的直接轉回營運金鑰；已經存進帳本合約的要憑證據提領（第 6 期的提領工具）
    const inWallet = await wallet(mm.address);
    if (inWallet > 0n) {
      await ensureGas();
      await send(mmClient, mm, { address: D.settlementToken, abi: erc20Abi, functionName: "transfer", args: [op.address, inWallet] }, "收回資金");
    }
    const inLedger = cashOf(agent.state(), mm.address);
    state.halted = {
      reason: `已撤回全部報價${inWallet > 0n ? `，錢包裡的 ${twd(inWallet)} 元轉回營運金鑰` : ""}。帳本裡的 ${twd(inLedger)} 元留在帳本合約，要憑餘額證據提領。按「恢復」重新報價`,
      at: new Date().toISOString(),
    };
    note(`收回資金：撤單，錢包 ${twd(inWallet)} 元轉回`);
    s = agent.state(); book = readBook(s);
  }

  // ── 部位與參考價 ──
  const mineLive = book.mineAll.filter((o) => o.expiry > nowSec());
  const cash = cashOf(s, mm.address);
  const holdings = readHoldings(s, mm.address);
  const freeKg = holdings.reduce((a, h) => a + h.kg, 0);
  const listedKg = mineLive.filter((o) => o.side === "sell").reduce((a, o) => a + Number(o.remainingKg), 0);
  const bidEscrow = book.mineAll.filter((o) => o.side === "buy").reduce((a, o) => a + o.locked, 0n);
  const inventoryKg = freeKg + listedKg + book.mineAll.filter((o) => o.side === "sell" && o.expiry <= nowSec()).reduce((a, o) => a + Number(o.remainingKg), 0);
  const ext = bestExternal({ orders: book.orders.filter((o) => o.country === COUNTRY), bids: book.bids.filter((b) => !b.country || b.country === COUNTRY), platform });
  // 交叉防護看的是**除了自己以外的所有單**（含模擬人物的）：參考價不能拿平台自己的單來算，
  // 但簿子上不管是誰的單，買價高過賣價就是一本壞掉的簿子。（寫入鎖裡另有一道 guard，見 passive）
  const cross = bestExternal({ orders: book.orders.filter((o) => o.country === COUNTRY), bids: book.bids.filter((b) => !b.country || b.country === COUNTRY), platform: platformSet([mm.address]) });
  const ref = referencePrice({ trades: readTrades(s), bestBid: ext.bestBid, bestAsk: ext.bestAsk, config: cfg });
  const equity = equityOf({ cash, bidEscrow, inventoryKg, ref: ref.price });
  // 損益一律扣掉撥款：撥進來的錢不是賺的，收回去的錢也不是賠的。
  const net = equity - BigInt(state.fundedTotal);
  const day = taipeiDay(Math.floor(Date.now() / 1000));
  if (state.day !== day || state.dayStartNet == null) { state.day = day; state.dayStartNet = net.toString(); }
  const risk = riskCheck({ equity: net, dayStartEquity: BigInt(state.dayStartNet), config: cfg });
  if (risk.halt && !state.halted) {
    state.halted = { reason: risk.reason, at: new Date().toISOString() };
    note(`停損：${risk.reason}`);
  }

  const feeBps = Number(tradeBpsOf(s, COUNTRY));
  const warnings = [...problems, ...spreadWarnings(cfg, feeBps)];
  if (cfg.simulation.enabled && !SIM_ALLOWED) warnings.push(`chainId ${chainId} 不在 SIMULATION_CHAINS（${[...SIM_CHAINS].join(",")}），模擬交易不會啟動`);
  const funded = BigInt(state.fundedTotal);
  const cap = BigInt(cfg.capitalTWD) * UNIT;
  if (funded > cap) warnings.push(`已撥款 ${twd(funded)} 元超過目前上限 ${cfg.capitalTWD} 元：不會自動收回，要收回請按「收回資金」`);

  let action = "idle";
  if (!cfg.enabled || state.halted) {
    if (book.mineAll.length) await cancelAll(book.mineAll, state.halted ? "已停止" : "做市已關閉");
    action = state.halted ? "halted" : "disabled";
  } else {
    await onboard();

    // ── 撥款：只補到上限為止。虧掉的不會自動補——那會讓停損失去意義 ──
    if (funded < cap) {
      const given = await fund(cap - funded, warnings);
      if (given > 0n) { state.fundedTotal = (funded + given).toString(); note(`撥款 ${twd(given)} 元給做市帳戶`); }
    }

    // ── 到期或快到期的報價先撤（鎖住的錢與額度要撤單才會退回）──
    const soon = nowSec() + 3600n;
    const stale = book.mineAll.filter((o) => o.expiry <= soon);
    for (const o of stale) await cancel(o, "撤到期報價");

    // ── 報價 ──
    s = agent.state(); book = readBook(s);
    const mineBids = book.mineAll.filter((o) => o.side === "buy").map((o) => ({ id: Number(o.seq), price: o.pricePerTonne, remainingKg: Number(o.remainingKg) }));
    const mineAsks = book.mineAll.filter((o) => o.side === "sell").map((o) => ({ id: Number(o.seq), price: o.pricePerTonne, remainingKg: Number(o.remainingKg), batchId: Number(o.batchId) }));
    const cashNow = cashOf(s, mm.address);
    const target = targetQuotes({
      ref: ref.price, config: cfg, inventoryKg,
      freeInventoryKg: readHoldings(s, mm.address).reduce((a, h) => a + h.kg, 0) + mineAsks.reduce((a, o) => a + o.remainingKg, 0),
      cash: cashNow + book.mineAll.filter((o) => o.side === "buy").reduce((a, o) => a + o.locked, 0n),
      bestExternalBid: cross.bestBid, bestExternalAsk: cross.bestAsk,
    });
    const bidPlan = planRequote({ current: mineBids, target: target.bids, requoteBps: cfg.requoteBps });
    const askPlan = planRequote({ current: mineAsks, target: target.asks, requoteBps: cfg.requoteBps });

    for (const b of bidPlan.cancel) await cancel(b, "撤買單");
    for (const o of askPlan.cancel) await cancel(o, "撤賣單");

    const expiry = nowSec() + QUOTE_TTL;
    let skipped = 0;
    for (const q of bidPlan.place) {
      const body = { side: "buy", batchId: 0n, country: COUNTRY, amountKg: BigInt(q.kg), pricePerTonne: q.price, minFillKg: BigInt(target.minFillKg), expiry };
      if (!(await put("place", body, "掛買單", passive(body)))) skipped += 1;
    }
    // 賣單要指定批次：撤單之後重讀持有，從持有最多的批次開始分配（只賣做市報價的那個核發國）
    const free = askPlan.place.length ? readHoldings(agent.state(), mm.address).filter((h) => h.country === COUNTRY) : [];
    for (const q of askPlan.place) {
      let left = q.kg;
      for (const h of free) {
        if (left <= 0) break;
        const kg = Math.min(left, h.kg);
        if (kg < target.minFillKg) continue;
        const body = { side: "sell", batchId: BigInt(h.batchId), country: "", amountKg: BigInt(kg), pricePerTonne: q.price, minFillKg: BigInt(target.minFillKg), expiry };
        const r = await put("place", body, `掛賣單（批次 #${h.batchId}）`, passive(body));
        if (!r) { skipped += 1; continue; }
        if (r.rejectedReason) { h.kg = 0; continue; } // 轄區被關掉的批次不能上架；換下一批，不要整輪停住
        h.kg -= kg; left -= kg;
      }
    }
    if (skipped) note(`${skipped} 張報價在寫入前一刻會和簿子上的單交叉，這一輪先不掛`);
    const changed = stale.length + bidPlan.cancel.length + askPlan.cancel.length + bidPlan.place.length + askPlan.place.length;
    action = changed ? `requoted:${changed}` : "quoting";
  }

  // ── 狀態 ──
  const sEnd = agent.state();
  const after = readBook(sEnd);
  const myOrders = after.mineAll.filter((o) => o.side === "sell");
  const myBids = after.mineAll.filter((o) => o.side === "buy");
  const holdEnd = readHoldings(sEnd, mm.address);
  const cashEnd = cashOf(sEnd, mm.address);
  const gas = await pub.getBalance({ address: mm.address });
  const escrowEnd = myBids.reduce((a, b) => a + b.locked, 0n);
  const invEnd = holdEnd.reduce((a, h) => a + h.kg, 0) + myOrders.reduce((a, o) => a + Number(o.remainingKg), 0);
  const equityEnd = equityOf({ cash: cashEnd, bidEscrow: escrowEnd, inventoryKg: invEnd, ref: ref.price });
  saveState(state);
  writeJson(F.status, {
    heartbeatAt: new Date().toISOString(), pid: process.pid, chainId, rpc: RPC.replace(/\/\/[^@]*@/, "//"),
    venue: "ledger", ledgerHead: String(store.head().seq), country: COUNTRY,
    intervalSec: cfg.intervalSec, action, halted: state.halted,
    marketMaker: mm.address, operator: op.address,
    ref: { pricePerTonne: twd(ref.price), source: ref.source },
    cash: twd(cashEnd), bidEscrow: twd(escrowEnd), inventoryKg: invEnd, freeInventoryKg: holdEnd.reduce((a, h) => a + h.kg, 0),
    equity: twd(equityEnd),
    pnl: twd(equityEnd - BigInt(state.fundedTotal)),
    dayPnl: twd(equityEnd - BigInt(state.fundedTotal) - BigInt(state.dayStartNet)),
    fundedTotal: twd(BigInt(state.fundedTotal)), capitalTWD: cfg.capitalTWD, feeBps,
    gas: Number(gas) / 1e18,
    quotes: {
      bids: myBids.map((b) => ({ id: Number(b.seq), pricePerTonne: twd(b.pricePerTonne), kg: Number(b.remainingKg) })).sort((a, b) => b.pricePerTonne - a.pricePerTonne),
      asks: myOrders.map((o) => ({ id: Number(o.seq), pricePerTonne: twd(o.pricePerTonne), kg: Number(o.remainingKg), batchId: Number(o.batchId) })).sort((a, b) => a.pricePerTonne - b.pricePerTonne),
    },
    externalBest: { bid: ext.bestBid === null ? null : twd(ext.bestBid), ask: ext.bestAsk === null ? null : twd(ext.bestAsk) },
    simulation: { ...simulation, running: !!sim, chains: [...SIM_CHAINS] },
    warnings, recent, eventsThisTick,
  });
  writeJson(F.accounts, {
    note: "平台做市帳戶。只被動報價，不與平台控制的帳戶成交。",
    chainId, marketMakers: [mm.address], platform: [op.address], simulationActive: !!sim,
    updatedAt: new Date().toISOString(),
  });
  return cfg;
}

// ───────────────────────── 主迴圈 ─────────────────────────

log(`後台做市啟動：chainId ${chainId}，帳本 ${D.ledger}，做市帳戶 ${mm.address}，營運金鑰 ${op.address}`);
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
    if (ONCE) process.exitCode = 1;
  }
  if (ONCE) break;
  for (let i = 0; i < interval && !stop; i++) await sleep(1000);
}
if (sim) sim.kill("SIGINT");
log("後台做市已停止");
