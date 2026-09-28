#!/usr/bin/env node
// 模擬市場（帳本 v2，設計 v4 第 5 期）：一群虛構人物持續在帳本裡交易。
//
//   cd web && node --experimental-strip-types scripts/ledger-sim.mjs --users 30 --interval 300
//   … --ticks 5            # 跑五輪就結束（測試、外部鏈上鋪一點資料）
//   … --avoid 0xMM,0x…     # 不和這些帳戶成交（後台做市會帶自己的地址）
//
// 每一筆都是人物自己簽的 EIP-712（和網站使用者同一種），寫進鏈下帳本、由引擎撮合。
// 只有**入金**是鏈上交易：營運 Safe 確認一筆（虛構的）新台幣入金、記在人物名下（bankRef 以 sim: 開頭，查核時分得出來）。
//
// 模擬人物只在 SIMULATION_CHAINS 列出的鏈上跑。名冊寫在 web/data/sim-personas.json：
// 網站靠它在掛單簿上標「模擬」，做市程式靠它避開平台自己的帳戶。
//
// ## 不和做市帳戶成交
//
// 帳本是價格優先自動撮合：模擬人物的買單只要價格碰到做市帳戶的賣價，就會先和做市帳戶成交。
// 所以模擬人物的委託**一律落在做市報價之內**（買價低於做市最低賣價、賣價高於做市最高買價），
// 而且這個判斷在帳本的寫入鎖裡用最新的簿子再做一次（agent.wouldMatch）——鎖外看到的簿子，
// 到寫進去的那一刻可能已經被做市程式改過了。
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes } from "viem";
import { english, generateMnemonic, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { buildPersonas, mulberry32 } from "./personas.mjs";
import { ANVIL_MNEMONIC, KeyError, appendIfMissing, keyring, operatorOwnerAccounts, setting } from "./lib/keys.mjs";

const { openStore } = await import("../lib/ledger/store.ts");
const { createAgent, wouldMatch } = await import("../lib/ledger/agent.ts");
const { readAuthorities } = await import("../lib/ledger/chain.ts");
const { bankRefOf, creditDepositCall, execOperatorSafe } = await import("../lib/ledger/fiat.ts");
const { isActive } = await import("../lib/ledger/engine.ts");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const USERS = Math.max(2, Math.min(100, Number(arg("users", 30))));
const INTERVAL = Math.max(1, Number(arg("interval", 300)));
const TICKS = Number(arg("ticks", 0)); // 0 = 一直跑
const SEED = arg("seed", "co2x-ledger"); // 和 ledger-seed 同一個：接著回填出來的那批人繼續交易
const QUIET = process.argv.includes("--quiet");
const AVOID_ARG = String(arg("avoid", "")).split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);

const RPC = setting("RPC_URL") ?? "http://127.0.0.1:28545";
const pub0 = createPublicClient({ transport: http(RPC) });
const chainId = await pub0.getChainId().catch(() => { console.error(`連不上 ${RPC}`); process.exit(1); });
const LOCAL = chainId === 31337 || chainId === 1337;
const SIM_CHAINS = new Set(String(setting("SIMULATION_CHAINS") ?? "31337,1337,8018").split(",").map((x) => Number(x.trim())).filter(Boolean));
if (!SIM_CHAINS.has(chainId)) { console.error(`chainId ${chainId} 不在 SIMULATION_CHAINS，不跑模擬人物`); process.exit(1); }
const chain = defineChain({ id: chainId, name: "co2x", nativeCurrency: { name: "N", symbol: "N", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: LOCAL ? 50 : 1000 });
const D = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`), "utf8"));
if (!D.ledger) { console.error("部署檔不是帳本部署（script/DeployLedger.s.sol）。請先 bash script/bootstrap.sh deploy"); process.exit(1); }
const DATA = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");

// ── 金鑰 ──
let op, idv, cv, receiptSigner, MNEMONIC;
try {
  const ring = keyring({ chainId, isLocal: LOCAL });
  op = privateKeyToAccount(ring.require("DEPLOYER_PK", "RELAYER_PK").pk);
  idv = privateKeyToAccount(ring.require("IDENTITY_VERIFIER_PK").pk);
  cv = privateKeyToAccount(ring.require("CARBON_VERIFIER_PK").pk);
  receiptSigner = privateKeyToAccount(ring.require("RECEIPT_SIGNER_PK", "RELAYER_PK").pk);
  MNEMONIC = arg("mnemonic", ring.secret("SIM_MNEMONIC")?.value);
} catch (e) {
  if (e instanceof KeyError) { console.error(`\n${e.message}`); process.exit(1); }
  throw e;
}
// anvil 的助記詞是公開的。公開鏈上用它，人物帳戶的私鑰全世界都有（誰都能冒用這些已登記身分的帳戶）。
if (!MNEMONIC) {
  if (LOCAL) MNEMONIC = ANVIL_MNEMONIC;
  else {
    MNEMONIC = generateMnemonic(english);
    appendIfMissing("SIM_MNEMONIC", MNEMONIC);
    console.log("  已產生模擬人物用的助記詞，寫入 web/.env.local 的 SIM_MNEMONIC（不會印出來）");
  }
}
if (!LOCAL && MNEMONIC.trim() === ANVIL_MNEMONIC) { console.error(`SIM_MNEMONIC 是 anvil 的公開助記詞，chainId ${chainId} 不是本機鏈`); process.exit(1); }

const personas = buildPersonas(USERS, SEED);
for (const p of personas) { p.account = mnemonicToAccount(MNEMONIC, { addressIndex: p.walletIndex }); p.address = p.account.address; }
writeRoster();

// ── 帳本 ──
const store = openStore(process.env.LEDGER_DIR ?? path.join(DATA, "ledger"));
let authCache = null;
const authorities = async () => {
  if (authCache && Date.now() - authCache.at < 60_000) return authCache.value;
  const value = await readAuthorities(pub, D.ledger, { fromBlock: BigInt(D.deployedAtBlock ?? 0) });
  authCache = { at: Date.now(), value };
  return value;
};
const agent = createAgent({ store, client: pub, domains: { chainId, ledger: D.ledger }, receiptSigner, authorities, fromBlock: BigInt(D.deployedAtBlock ?? 0) });

const low = (a) => String(a).toLowerCase();
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const P = (x) => BigInt(Math.round(x)) * 1_000_000n;
const TICK = 1_000_000n;
const log = (...a) => { if (!QUIET) console.log(...a); };
const rng = mulberry32(`${SEED}-live-${Date.now() >> 20}`);

/// 要迴避的帳戶：命令列帶的，加上做市程式公開揭露的做市帳戶
function avoidSet() {
  const s = new Set(AVOID_ARG);
  try {
    const a = JSON.parse(fs.readFileSync(path.join(DATA, "mm", "accounts.json"), "utf8"));
    if (a.chainId === chainId) for (const m of a.marketMakers ?? []) s.add(low(m));
  } catch { /* 沒有做市程式 */ }
  return s;
}

// ── 入金（營運 Safe 確認；模擬人物的錢是虛構的，bankRef 一律以 sim: 開頭）──
const opW = createWalletClient({ account: op, chain, transport: http(RPC) });
const owners = await operatorOwnerAccounts({ isLocal: LOCAL });
if (owners.length === 0) log("  ⚠️ 這台機器上沒有營運 Safe 持有人的金鑰（.governance.env），模擬人物不會入金");
/// 每位人物的入金上限：預設依人物設定；`SIM_BUDGET_TWD` 可以直接指定每人多少元。
let perPersonaCap = null;
async function planBudget() {
  const fixed = setting("SIM_BUDGET_TWD");
  if (fixed) { perPersonaCap = BigInt(fixed) * 1_000_000n; console.log(`  每位買方入金上限 ${fixed} 元（SIM_BUDGET_TWD）`); }
}
/// 帳本裡的現金低於預算的四分之一就補到預算。回傳入金多少。
async function topUp(p) {
  if (owners.length === 0) return 0n;
  const s = agent.state();
  let budget = BigInt(Math.max(30_000, (p.annualNeedTonnes || 50) * 1_500)) * 1_000_000n;
  if (perPersonaCap !== null && budget > perPersonaCap) budget = perPersonaCap;
  if (budget <= 0n) return 0n;
  const have = (s.cash.get(low(p.address)) ?? 0n) + (s.lockedCash.get(low(p.address)) ?? 0n);
  if (have >= budget / 4n) return 0n;
  const want = budget - have;
  const ref = `sim:${p.address.slice(2, 10)}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
  const call = creditDepositCall(D.ledger, p.address, want, bankRefOf("in", ref));
  await execOperatorSafe({ pub, sender: opW, safe: D.operatorSafe, to: call.to, data: call.data, owners });
  return want;
}

// ── 帳本動作 ──
let counts = { place: 0, cancel: 0, retire: 0, issue: 0, skipped: 0, rejected: 0, fills: 0 };
async function user(p, kind, body, guard) {
  const r = await agent.user(p.account, kind, body, { guard });
  if (!r) { counts.skipped += 1; return null; }
  counts[kind] = (counts[kind] ?? 0) + 1;
  if (r.rejectedReason) counts.rejected += 1;
  counts.fills += r.fills.length;
  return r;
}
/// 這張單不能碰到要迴避的帳戶（在寫入鎖裡判斷）
const clear = (p, q) => (s) => !wouldMatch(s, { ...q, account: p.address }, nowSec(), (a) => avoidSet().has(low(a)));

/// 做市帳戶現在的報價邊界：模擬人物的買價要低於它的最低賣價、賣價要高於它的最高買價
function mmBounds(s) {
  const avoid = avoidSet();
  const t = nowSec();
  let ask = null, bid = null;
  for (const o of s.book.values()) {
    if (o.expiry <= t || o.remainingKg === 0n || !avoid.has(low(o.account))) continue;
    if (o.side === "sell" && (ask === null || o.pricePerTonne < ask)) ask = o.pricePerTonne;
    if (o.side === "buy" && (bid === null || o.pricePerTonne > bid)) bid = o.pricePerTonne;
  }
  return { ask, bid };
}

async function setup() {
  let n = 0;
  for (const p of personas) {
    const s = agent.state();
    if (isActive(s, p.address, nowSec() + 86400n)) continue;
    const t = nowSec();
    await agent.authority(idv, "identity", {
      account: p.address, tier: p.tier === "individual" ? 1 : 2, expiry: t + 365n * 86400n, jurisdiction: p.country,
      identityHash: keccak256(toBytes(`sim:${p.id}:${p.name}`)), nonce: s.identities.get(low(p.address))?.attNonce ?? 0n, deadline: t + 3600n,
    });
    n += 1;
  }
  for (const p of personas.filter((x) => x.role === "developer")) {
    if (projectOf(p)) continue;
    await user(p, "project", { name: p.projectName, methodology: p.project.methodology, location: `${p.city}, ${p.country}`, metadataURI: `ipfs://sim/${p.id}` });
  }
  if (n) log(`  ${n} 個模擬人物完成身分登記`);
}
const projectOf = (p) => [...agent.state().projects.values()].find((x) => low(x.owner) === low(p.address));
const holdings = (addr) => [...(agent.state().credits.get(low(addr)) ?? new Map()).entries()].map(([id, kg]) => ({ id: BigInt(id), kg }));

let ref = 800;
let round = 0;
async function tickOnce() {
  round += 1;
  counts = { place: 0, cancel: 0, retire: 0, issue: 0, skipped: 0, rejected: 0, fills: 0 };
  const t = nowSec();
  const ttl = BigInt(Math.max(3600, INTERVAL * 20));
  const devs = personas.filter((p) => p.role === "developer");
  const buyers = personas.filter((p) => p.role !== "developer");

  // 到期的單撤掉，拿回鎖住的錢與額度
  for (const p of personas) {
    for (const o of [...agent.state().book.values()]) {
      if (low(o.account) === low(p.address) && o.expiry <= t) await user(p, "cancel", { orderSeq: o.seq });
    }
  }
  // 入金
  let deposited = 0n;
  for (const p of buyers) deposited += await topUp(p).catch((e) => { log(`  入金失敗（${p.name}）：${String(e.shortMessage ?? e.message).slice(0, 80)}`); return 0n; });
  if (deposited > 0n) await agent.mirror(D.ledger);

  // 核發：第一輪每個專案方都核發一批（市場要有供給），之後大約每 20 輪一批
  for (const p of devs) {
    const pr = projectOf(p);
    if (!pr || (round > 1 && rng() > 1 / 20)) continue;
    if (round === 1 && holdings(p.address).length) continue;
    const n = BigInt(Math.floor(Date.now() / 1000)) * 1000n + BigInt(Math.floor(rng() * 1000));
    await agent.authority(cv, "issue", {
      projectId: pr.id, monitoringStart: t - 365n * 86400n, monitoringEnd: t - 86400n,
      amountKg: BigInt(Math.round(p.projectScaleTonnes * (0.15 + rng() * 0.2)) * 1000),
      serialHash: keccak256(toBytes(`${SEED}-live-serial-${p.id}-${n}`)), reportHash: keccak256(toBytes(`${SEED}-live-report-${p.id}-${n}`)),
      attestationId: n, deadline: t + 3600n,
    });
    counts.issue += 1;
  }

  const mm = mmBounds(agent.state());
  // 賣方：專案方掛出一部分持有；價格不低於成本，也要高於做市帳戶的最高買價
  for (const p of devs) {
    for (const h of holdings(p.address)) {
      if (h.kg < 1000n || rng() > 0.5) continue;
      const kg = (h.kg * BigInt(20 + Math.floor(rng() * 30))) / 100n;
      let price = P(Math.max(p.costPerTonne ?? 450, ref * (0.95 + rng() * 0.2)));
      if (mm.bid !== null && price <= mm.bid) price = mm.bid + TICK * BigInt(1 + Math.floor(rng() * 5));
      const body = { side: "sell", batchId: h.id, country: "", amountKg: kg, pricePerTonne: price, minFillKg: 100n, expiry: t + ttl };
      await user(p, "place", body, clear(p, body));
    }
  }
  // 買方：依活躍度下單；價格繞著參考價，但要低於做市帳戶的最低賣價
  for (const p of buyers) {
    if (rng() > Math.min(0.9, p.activity * 2)) continue;
    const tonnes = Math.max(1, Math.round(((p.annualNeedTonnes || 50) / 30) * (0.5 + rng())));
    let price = P(ref * (0.95 + rng() * 0.15) * p.priceTolerance);
    if (mm.ask !== null && price >= mm.ask) price = mm.ask - TICK * BigInt(1 + Math.floor(rng() * 5));
    if (price <= 0n) continue;
    // 買得起多少就下多少：入金有上限時（沒有營運 Safe 金鑰、只能用帳本裡已有的錢），預算常常只夠一兩噸，超過的單只會被引擎以「餘額不足」拒絕
    const cash = agent.state().cash.get(low(p.address)) ?? 0n;
    let kg = BigInt(tonnes * 1000);
    const affordable = (cash * 1000n) / price;
    if (kg > affordable) kg = (affordable / 100n) * 100n;
    if (kg < 100n) continue;
    const body = { side: "buy", batchId: 0n, country: "TW", amountKg: kg, pricePerTonne: price, minFillKg: 0n, expiry: t + ttl };
    await user(p, "place", body, clear(p, body));
  }
  // 註銷：法人買方偶爾註銷手上的一部分（受益人與用途照他的角色）
  for (const p of buyers.filter((x) => x.tier === "corporate" && x.role !== "maker")) {
    if (rng() > 1 / 14) continue;
    for (const h of holdings(p.address)) {
      if (h.kg < 1000n) continue;
      const purpose = p.role === "eia" ? 2 : p.role === "compliance" ? 0 : 1;
      await user(p, "retire", { batchId: h.id, amountKg: h.kg / 2n, beneficiary: p.name, beneficiaryHash: keccak256(toBytes(`ben:${p.id}`)), purpose, memo: `${new Date().getUTCFullYear()} 申報` });
    }
  }
  // 參考價跟著國內成交走（做市帳戶的成交也算：那是市場價格）
  const recent = agent.state().fills.filter((f) => f.country === "TW").slice(-10);
  if (recent.length) ref = recent.reduce((a, f) => a + Number(f.pricePerTonne) / 1e6, 0) / recent.length * (0.995 + rng() * 0.02);
  ref = Math.min(2200, Math.max(400, ref));

  const s = agent.state();
  const mmFills = s.fills.filter((f) => avoidSet().has(low(f.buyer)) || avoidSet().has(low(f.seller)))
    .filter((f) => personas.some((p) => low(p.address) === low(f.buyer) || low(p.address) === low(f.seller)));
  console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} 第 ${round} 輪：掛單 ${counts.place}、撤單 ${counts.cancel}、成交 ${counts.fills}、註銷 ${counts.retire}、核發 ${counts.issue}、避開做市 ${counts.skipped}、被拒 ${counts.rejected}；參考價 ${Math.round(ref)}；帳本 ${store.head().seq} 筆${mmFills.length ? `；⚠️ 模擬人物與做市帳戶成交 ${mmFills.length} 筆` : ""}`);
}

function writeRoster() {
  const rosterPath = path.join(DATA, "sim-personas.json");
  fs.mkdirSync(path.dirname(rosterPath), { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const current = personas.map(({ account, ...p }) => ({ ...p, active: true }));
  let previous = [];
  try {
    const old = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
    const have = new Set(current.map((p) => low(p.address)));
    previous = (old.personas ?? []).filter((p) => p.address && !have.has(low(p.address))).map((p) => ({ ...p, active: false }));
  } catch { /* 第一次跑 */ }
  fs.writeFileSync(rosterPath, JSON.stringify({
    note: "模擬用虛構人物，與任何真實公司或個人無關", seed: SEED, chainId, generatedAt: new Date().toISOString(),
    personas: [...current, ...previous],
    // 地址只由助記詞與 walletIndex（100 起）決定。整段位址空間都列出來，換人數也認得出是模擬人物。
    addressSpace: Array.from({ length: Math.max(USERS, 100) }, (_, i) => mnemonicToAccount(MNEMONIC, { addressIndex: 100 + i }).address),
  }, null, 2));
}

// ── 主迴圈 ──
let stop = false;
process.on("SIGINT", () => { stop = true; });
process.on("SIGTERM", () => { stop = true; });
console.log(`模擬市場（帳本）：chainId ${chainId}，${USERS} 人，每 ${INTERVAL} 秒一輪${TICKS ? `，共 ${TICKS} 輪` : ""}；迴避 ${[...avoidSet()].join(", ") || "（無）"}`);
await setup();
await planBudget();
while (!stop) {
  try { await tickOnce(); } catch (e) { console.error(`本輪失敗：${String(e.shortMessage ?? e.message).slice(0, 300)}`); }
  if (TICKS && round >= TICKS) break;
  for (let i = 0; i < INTERVAL && !stop; i++) await new Promise((r) => setTimeout(r, 1000));
}
