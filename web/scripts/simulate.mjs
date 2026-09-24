#!/usr/bin/env node
/**
 * 市場模擬器：一百個有人格的帳戶，在鏈上真的交易。
 *
 *   cd web
 *   npm run simulate -- --from 2025-09-20      # 從那天回填到現在，跑完就結束
 *   npm run simulate                            # 持續模式：依真實時間，每分鐘跑一輪
 *   npm run simulate -- --dry-run               # 只印人物名冊，不送任何交易
 *
 * 參數：
 *   --users N        帳戶數（預設 100）
 *   --from DATE      回填起點（YYYY-MM-DD 或 ISO 時間）。不給就是持續模式。
 *   --tick DUR       回填時每一輪代表多久（預設 6h，可寫 30m / 2h / 1d）
 *   --interval SEC   持續模式的實際間隔秒數（預設 60）
 *   --seed S         人物種子（預設 co2x）；同一個種子一定產生同一批人
 *   --mnemonic M     推導帳戶的助記詞（預設 anvil 的測試助記詞）
 *   --rpc URL        預設 $RPC_URL 或 http://127.0.0.1:28545
 *   --pace SEC       縮時模式下每一輪之間實際等待幾秒（預設 0＝全速）
 *   --quiet          只印每一輪的摘要
 *
 * ## 兩種回填，看鏈讓不讓你調時間
 *
 * **anvil**：把鏈的時間一輪一輪往前推（anvil_setTime），所以交易的時間戳就是
 * 劇本的時間戳，K 線的橫軸真的是一整年。區塊時間只能往前不能倒退，所以 --from
 * 必須晚於鏈上現在的時間，anvil 要從一年前起算：
 *   anvil --timestamp $(( $(date +%s) - 365*86400 ))
 *
 * **公開鏈**：調不動時間，而且沒有替代方案——區塊時間由出塊的人決定。
 * 腳本會自己偵測並切換到**縮時模式**：劇本照樣走一年（申報季、每月對帳、
 * 人物陸續加入都照劇本），但交易全部發生在現在。
 *
 *   npm run simulate -- --from 2025-09-25 --tick 8h --pace 60
 *
 * 換來的是「行為上是一整年、時間戳上是這幾天」。量能分布、各國佔比、掛單結構
 * 都對；K 線的橫軸是真實日期，想拉長就把 --pace 調大讓它跑好幾天。
 * 這是公開鏈的固有限制，不是實作偷懶——寫在這裡，免得下一個人以為可以修好。
 *
 * 設計上的兩個決定：
 *
 * 1. **模擬器是鏈上唯一的寫入者**，所以掛單簿與持有量都在記憶體裡跟著更新，
 *    不必每一輪重讀鏈。啟動時讀一次現況（demo 腳本留下的單也會被接手），之後靠自己記帳。
 *    這讓一年份的回填從「幾萬次 RPC」降到「幾千筆交易」。
 *
 * 2. **行為從人物設定推導，不是亂數決定**。誰在什麼時候買、買多少、願意出什麼價、
 *    買完之後會不會註銷，都由角色、申報季與預算決定——所以圖表上看得到申報季的量能，
 *    而不是一條均勻的雜訊。
 */
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, toBytes, toHex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { buildPersonas, mulberry32, rosterSummary, seasonality } from "./personas.mjs";

// ───────────────────────── 參數 ─────────────────────────

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const RPC = arg("rpc", process.env.RPC_URL ?? "http://127.0.0.1:28545");
const USERS = Number(arg("users", 100));
const SEED = arg("seed", "co2x");
const FROM = arg("from", null);
const INTERVAL = Number(arg("interval", 60));
const QUIET = flag("quiet");
const DRY = flag("dry-run");
const MNEMONIC = arg("mnemonic", process.env.SIM_MNEMONIC ?? "test test test test test test test test test test test junk");

function parseDuration(s, dflt) {
  if (!s) return dflt;
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(s.trim());
  if (!m) throw new Error(`看不懂的時間長度：${s}（可寫 30m / 6h / 1d）`);
  return Math.round(Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]]);
}
const TICK = parseDuration(arg("tick", "6h"), 6 * 3600);
/// 縮時模式下每一輪之間實際等待幾秒。0 = 全速跑完（幾分鐘內結束，K 線會擠在一個點上）；
/// 設大一點並讓它在背景跑好幾天，橫軸才拉得開。
const PACE = Number(arg("pace", 0));

// ───────────────────────── 人物 ─────────────────────────

const personas = buildPersonas(USERS, SEED);
for (const p of personas) {
  p.account = mnemonicToAccount(MNEMONIC, { addressIndex: p.walletIndex });
  p.address = p.account.address;
}

if (DRY) {
  const s = rosterSummary(personas);
  console.log(`人物名冊（seed=${SEED}，共 ${s.total} 人；全部為虛構）\n`);
  console.log("角色分布：", s.roles.map(([k, v]) => `${k} ${v}`).join("、"));
  console.log("申報地：  ", s.countries.map(([k, v]) => `${k} ${v}`).join("、"));
  console.log(`年需求量：約 ${s.annualDemandTonnes.toLocaleString()} 噸；專案方年供給：約 ${s.supplyTonnes.toLocaleString()} 噸\n`);
  for (const p of personas.slice(0, 12)) {
    console.log(
      `#${String(p.id).padStart(3)} ${p.name.padEnd(16)} ${p.roleLabel.padEnd(7)} ${p.city}(${p.country}) ` +
      `${p.industry.padEnd(5)} 年需求 ${String(p.annualNeedTonnes).padStart(5)} 噸 ` +
      `心理價 ×${p.priceTolerance} 活躍度 ${p.activity}` + (p.leakageRisk ? " 〔高碳洩漏風險〕" : ""),
    );
  }
  console.log(`…（其餘 ${personas.length - 12} 人略）`);
  process.exit(0);
}

// ───────────────────────── 鏈與合約 ─────────────────────────

const ANVIL_PK0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OPERATOR_PK = process.env.DEPLOYER_PK ?? process.env.RELAYER_PK ?? ANVIL_PK0;

const kycAbi = parseAbi([
  "struct IdentityAttestation { address account; uint8 tier; uint64 expiry; bytes2 jurisdiction; bytes32 identityHash; uint256 nonce; uint256 deadline; }",
  "function register(IdentityAttestation a, bytes signature)",
  "function nonces(address) view returns (uint256)",
  "function isActive(address) view returns (bool)",
  "function tierOf(address) view returns (uint8)",
]);
const registryAbi = parseAbi([
  "struct IssuanceAttestation { uint256 projectId; uint64 monitoringStart; uint64 monitoringEnd; uint256 amountKg; bytes32 serialHash; bytes32 reportHash; uint256 attestationId; uint256 deadline; }",
  "struct Project { address owner; string name; string methodology; string location; string metadataURI; bool active; bytes2 country; string scheme; }",
  "function registerProject(string name, string methodology, string location, string metadataURI) returns (uint256)",
  "function issue(IssuanceAttestation a, bytes signature) returns (uint256)",
  "function projectOf(uint256) view returns (Project)",
  "function nextProjectId() view returns (uint256)",
]);
const creditAbi = parseAbi([
  "struct Batch { uint256 projectId; uint64 monitoringStart; uint64 monitoringEnd; uint16 vintageYear; bytes32 serialHash; bytes32 reportHash; address verifier; uint64 issuedAt; uint256 issuedKg; uint256 retiredKg; bool frozen; }",
  "struct RetireRequest { address holder; uint256 batchId; uint256 amountKg; address certificateTo; bytes32 beneficiaryHash; string beneficiary; uint8 purpose; string memo; }",
  "function balanceOf(address, uint256) view returns (uint256)",
  "function heldBatches(address) view returns (uint256[])",
  "function batchOf(uint256) view returns (Batch)",
  "function nextBatchId() view returns (uint256)",
  "function setApprovalForAll(address, bool)",
  "function isApprovedForAll(address, address) view returns (bool)",
  "function retire(RetireRequest r) returns (uint256)",
]);
const listingAbi = parseAbi([
  "struct Order { address seller; uint256 batchId; uint256 remainingKg; uint256 pricePerTonne; uint256 minFillKg; bool active; }",
  "function list(uint256 batchId, uint256 amountKg, uint256 pricePerTonne, uint256 minFillKg) returns (uint256)",
  "function buy(uint256 orderId, uint256 amountKg)",
  "function cancel(uint256 orderId)",
  "function orderOf(uint256) view returns (Order)",
  "function nextOrderId() view returns (uint256)",
  "struct Bid { address buyer; bytes2 country; uint256 remainingKg; uint256 pricePerTonne; uint256 minFillKg; bool active; uint256 escrow; }",
  "function placeBid(bytes2 country, uint256 amountKg, uint256 pricePerTonne, uint256 minFillKg) returns (uint256)",
  "function fillBid(uint256 bidId, uint256 batchId, uint256 amountKg)",
  "function cancelBid(uint256 bidId)",
  "function bidOf(uint256) view returns (Bid)",
  "function nextBidId() view returns (uint256)",
]);
const reserveAbi = parseAbi([
  "struct CreditReserve { bytes2 country; string custodian; string accountRef; uint256 heldKg; uint256 onchainKg; bytes32 statementHash; }",
  "struct CashReserve { string trustee; string accountRef; uint256 balance; uint256 tokenSupply; bytes32 statementHash; }",
  "function publish(uint32 period, uint64 asOf, CreditReserve[] credits, CashReserve cash) returns (uint256)",
  "function setDocumentHash(uint256 reportId, bytes32 documentHash)",
  "function attest(uint256 reportId, uint8 status, string auditorName, string note)",
  "function periods() view returns (uint32[])",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function mint(address, uint256)",
  "function totalSupply() view returns (uint256)",
]);

/// anvil 每筆交易當場出塊，viem 預設 4 秒的輪詢間隔等於每筆交易白等四秒。
/// 一年份的回填是幾千筆交易——這一個參數的差別是「四小時」與「二十分鐘」。
/// 公開鏈上反過來：問太快只是把 RPC 的額度燒掉，而出塊時間本來就是兩秒起跳。
let POLL = 50;
const pub0 = createPublicClient({ transport: http(RPC), pollingInterval: POLL });
const chainId = await pub0.getChainId().catch(() => {
  console.error(`連不上 ${RPC} —— 節點起來了嗎？`);
  process.exit(1);
});
const LOCAL_CHAIN = chainId === 31337 || chainId === 1337;
if (!LOCAL_CHAIN) POLL = 1000;
const chain = defineChain({
  id: chainId, name: "sim",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: POLL });

const depFile = process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`);
if (!fs.existsSync(depFile)) {
  console.error(`找不到部署檔 ${depFile} —— 請先跑 forge script script/DemoFlowV4.s.sol --rpc-url anvil --broadcast --sig "demo()"`);
  process.exit(1);
}
const D = JSON.parse(fs.readFileSync(depFile, "utf8"));

const operator = privateKeyToAccount(OPERATOR_PK);
const opClient = createWalletClient({ account: operator, chain, transport: http(RPC), pollingInterval: POLL });
const opWallet = { account: operator, client: opClient, nonce: -1 };

// ───────────────────────── 交易小工具 ─────────────────────────

const wallets = new Map(); // address -> { account, client, nonce }
function walletOf(p) {
  let w = wallets.get(p.address);
  if (!w) {
    w = { account: p.account, client: createWalletClient({ account: p.account, chain, transport: http(RPC), pollingInterval: POLL }), nonce: -1 };
    wallets.set(p.address, w);
  }
  return w;
}

let sent = 0, failed = 0;
async function send(w, params, needResult = false) {
  if (w.nonce < 0) w.nonce = await pub.getTransactionCount({ address: w.account.address });
  let request = { ...params, account: w.account }, result;
  if (needResult) ({ request, result } = await pub.simulateContract({ ...params, account: w.account }));
  const hash = await w.client.writeContract({ ...request, nonce: w.nonce });
  w.nonce += 1;
  const rc = await pub.waitForTransactionReceipt({ hash, retryCount: 3 });
  if (rc.status !== "success") throw new Error(`交易失敗 ${hash}`);
  sent += 1;
  return result;
}
/// 行為失敗不該中斷整場模擬——鏈上狀態會變，有些動作本來就會撲空。
async function attempt(label, fn) {
  // 動作自己回傳 false 代表「這次撲空」（沒貨可掛、沒單可買），不是錯誤，也不算一次行動。
  try { return (await fn()) !== false; }
  catch (e) {
    failed += 1;
    if (!QUIET && failed < 25) console.log(`  · 略過 ${label}：${String(e.shortMessage ?? e.message).slice(0, 90)}`);
    return false;
  }
}

// ───────────────────────── 鏈上時間 ─────────────────────────

async function chainNow() {
  return Number((await pub.getBlock({ blockTag: "latest" })).timestamp);
}
async function setChainTime(ts) {
  await pub.request({ method: "anvil_setTime", params: [toHex(ts)] });
}

/// 這條鏈讓不讓我們調時間？
///
/// anvil 讓，公開鏈不讓——而且**沒有任何替代方案**：區塊時間由出塊的人決定，
/// 我們只是一個送交易的客戶端。所以回填在公開鏈上要換一種做法（見下面的縮時模式），
/// 不是換一個 RPC 方法。
async function canTimeTravel() {
  if (!LOCAL_CHAIN) return false;
  try {
    await pub.request({ method: "anvil_setTime", params: [toHex(await chainNow())] });
    return true;
  } catch { return false; }
}

/// 一次決定，之後到處用。放在這裡而不是每次現問：探測本身要送一筆 RPC。
const TIME_TRAVEL = await canTimeTravel();

// ───────────────────────── 市場模型 ─────────────────────────

const orders = new Map();   // orderId -> { seller, batchId, remainingKg, price, minFillKg }
/// 買單簿。跟 orders 一樣放記憶體裡——模擬器是鏈上唯一的寫入者。
const bids = new Map();     // bidId -> { buyer, country, remainingKg, price }
const batchMeta = new Map(); // batchId -> { country, scheme, project, vintage }
const holdings = new Map(); // address -> Map(batchId -> kg)
const cash = new Map();     // address -> bigint（mTWD 最小單位）
const importedProjects = new Map(); // 國外專案名稱 -> projectId
const foreignMeta = new Map();      // projectId -> { country, scheme, name, methodology }
const publishedPeriods = new Set(); // 已發過對帳報告的期別 YYYYMM

const hold = (addr) => holdings.get(addr) ?? holdings.set(addr, new Map()).get(addr);
const addHold = (addr, batchId, kg) => {
  const h = hold(addr);
  const next = (h.get(batchId) ?? 0) + kg;
  if (next <= 0) h.delete(batchId); else h.set(batchId, next);
};

async function loadMarket() {
  const [nextOrder, nextBatch, nextBid] = await Promise.all([
    pub.readContract({ address: D.listing, abi: listingAbi, functionName: "nextOrderId" }),
    pub.readContract({ address: D.carbonCredit1155, abi: creditAbi, functionName: "nextBatchId" }),
    // 舊部署沒有買單，讀不到就當作 1（沒有任何買單）
    pub.readContract({ address: D.listing, abi: listingAbi, functionName: "nextBidId" }).catch(() => 1n),
  ]);
  // 批次與它的核發國：註銷用途要看國別，掛單也要標
  for (let id = 1n; id < nextBatch; id++) {
    const b = await pub.readContract({ address: D.carbonCredit1155, abi: creditAbi, functionName: "batchOf", args: [id] });
    const p = await pub.readContract({ address: D.carbonRegistry, abi: registryAbi, functionName: "projectOf", args: [b.projectId] });
    const country = Buffer.from(p.country.slice(2), "hex").toString("utf8").replace(/\0/g, "");
    batchMeta.set(Number(id), { country, scheme: p.scheme, project: p.name, vintage: b.vintageYear });
  }
  // 現有掛單（demo 腳本留下的也接手，讓模擬的人一開始就有東西可買）
  const firstOrder = Number(nextOrder) > 400 ? Number(nextOrder) - 400 : 1;
  for (let id = firstOrder; id < Number(nextOrder); id++) {
    const o = await pub.readContract({ address: D.listing, abi: listingAbi, functionName: "orderOf", args: [BigInt(id)] });
    if (o.active && o.remainingKg > 0n) {
      orders.set(id, {
        seller: o.seller, batchId: Number(o.batchId), remainingKg: Number(o.remainingKg),
        price: o.pricePerTonne, minFillKg: Number(o.minFillKg),
      });
    }
  }
  // 買單也要接回來，否則接續跑的時候簿子上那些買單模擬器看不見，
  // 賣方就永遠不會去成交它們，而買方還以為自己掛著。
  const firstBid = Number(nextBid) > 400 ? Number(nextBid) - 400 : 1;
  for (let id = firstBid; id < Number(nextBid); id++) {
    const b = await pub.readContract({ address: D.listing, abi: listingAbi, functionName: "bidOf", args: [BigInt(id)] });
    if (b.active && b.remainingKg > 0n) {
      bids.set(id, {
        buyer: b.buyer,
        country: Buffer.from(b.country.slice(2), "hex").toString("utf8").replace(/\0/g, ""),
        remainingKg: Number(b.remainingKg), price: b.pricePerTonne,
      });
    }
  }

  // 平台（部署者）手上的國外額度：模擬期間會分批放到市場上
  await loadHoldings(operator.address);

  // 已經在鏈上的人接手回來。模擬器中斷之後可以接著跑——不然只能砍掉 anvil 從頭來，
  // 而回填一年要二十分鐘，為了一個中斷重跑一次太貴。
  // 專案也要認回來，不然每次接手都會替同一個開發者再登錄一個一模一樣的專案，
  // 公告欄上就會出現三個「高雄 廢熱回收發電」。
  const nextProject = await pub.readContract({ address: D.carbonRegistry, abi: registryAbi, functionName: "nextProjectId" });
  const projectByOwner = new Map();
  for (let id = 1n; id < nextProject; id++) {
    const pr = await pub.readContract({ address: D.carbonRegistry, abi: registryAbi, functionName: "projectOf", args: [id] });
    if (pr.active && !projectByOwner.has(pr.owner.toLowerCase())) projectByOwner.set(pr.owner.toLowerCase(), Number(id));
  }

  let resumed = 0;
  for (const p of personas) {
    const active = await pub.readContract({ address: D.kycRegistry, abi: kycAbi, functionName: "isActive", args: [p.address] });
    if (!active) continue;
    p.joined = true;
    resumed += 1;
    p.projectId = projectByOwner.get(p.address.toLowerCase()) ?? p.projectId;
    await loadHoldings(p.address);
    cash.set(p.address, await pub.readContract({ address: D.settlementToken, abi: erc20Abi, functionName: "balanceOf", args: [p.address] }));
  }
  if (resumed > 0) console.log(`  接手已在鏈上的帳戶 ${resumed} 個（接續先前的模擬）`);

  // 已發過的對帳期別（接手時不要重發同一個月）
  const periods = await pub.readContract({ address: D.reserveAttestation, abi: reserveAbi, functionName: "periods" });
  for (const x of periods) publishedPeriods.add(Number(x));

  // 已登錄的國外專案（接手時不要再登錄一次同名專案）
  for (let id = 1n; id < nextProject; id++) {
    const pr = await pub.readContract({ address: D.carbonRegistry, abi: registryAbi, functionName: "projectOf", args: [id] });
    const country = Buffer.from(pr.country.slice(2), "hex").toString("utf8").replace(/\0/g, "");
    if (pr.active && country !== "TW" && pr.owner.toLowerCase() === operator.address.toLowerCase()) {
      importedProjects.set(pr.name, Number(id));
      foreignMeta.set(Number(id), { country, scheme: pr.scheme, name: pr.name, methodology: pr.methodology });
    }
  }

  // 參考價從簿子推回來：取現有掛單價格的中位數。用中位數不用平均，
  // 是因為簿子上常有一兩張掛得很離譜的單，平均會被它們拉走。
  const asks = [...orders.values()].map((o) => o.price).sort((a, b) => Number(a - b));
  if (asks.length >= 3) {
    refPrice = clampPrice(asks[Math.floor(asks.length / 2)]);
    anchorPrice = refPrice;
    console.log(`  參考價由掛單簿推回 ${(Number(refPrice) / 1e6).toFixed(0)} mTWD/噸`);
  }
}

/// 把一個地址目前持有的批次讀回記憶體
async function loadHoldings(addr) {
  const ids = await pub.readContract({ address: D.carbonCredit1155, abi: creditAbi, functionName: "heldBatches", args: [addr] });
  for (const id of ids) {
    const bal = await pub.readContract({ address: D.carbonCredit1155, abi: creditAbi, functionName: "balanceOf", args: [addr, id] });
    if (bal > 0n) addHold(addr, Number(id), Number(bal));
  }
}

/// 市場參考價（mTWD / 噸，以最小單位計）。有成交就跟著成交價走。
/// 起始值只在「鏈上還沒有任何掛單」時用得到；接手先前的模擬時會改由簿子推回來，
/// 不然每次接手價格都會跳回 800，圖表上出現一道跟市場無關的斷崖。
let refPrice = 800n * 10n ** 6n;
/// 買方的心理價位要有一個**慢的**參照。若直接用當天的參考價 × 心理價位倍數，
/// 價格漲多少、買方願意出的價就跟著漲多少——那等於沒有人會嫌貴，價格必然一路頂到上限。
/// 真實的預算是去年編的，跟得上大勢、跟不上一個月的急漲。這裡用半衰期很長的 EMA 當錨。
let anchorPrice = refPrice;
const PRICE_FLOOR = 300n * 10n ** 6n;
const PRICE_CEIL = 2200n * 10n ** 6n;
const clampPrice = (p) => (p < PRICE_FLOOR ? PRICE_FLOOR : p > PRICE_CEIL ? PRICE_CEIL : p);

// ───────────────────────── 身分與資金 ─────────────────────────

const TIER = { individual: 1, corporate: 2 };

/// 公開鏈上每個人物帳戶要自己付 gas，而 anvil_setBalance 不存在——
/// 只能由營運金鑰真的轉一筆過去。金額刻意小：Base Sepolia 這種 L2 上
/// 一筆交易大約是 1e-5 ETH 等級，GAS_TOPUP 夠跑幾百筆。
/// 太大則是把 faucet 領來的測試幣鎖在一百個地址裡拿不回來。
const GAS_TOPUP = BigInt(process.env.SIM_GAS_TOPUP ?? (LOCAL_CHAIN ? 10n ** 19n : 10n ** 15n));
const GAS_FLOOR = GAS_TOPUP / 5n;

async function ensureFunded(p) {
  const w = walletOf(p);
  const bal = await pub.getBalance({ address: p.address });
  if (bal >= GAS_FLOOR) return w;
  if (TIME_TRAVEL) {
    await pub.request({ method: "anvil_setBalance", params: [p.address, toHex(GAS_TOPUP)] });
    return w;
  }
  // 營運金鑰的 nonce 走它自己那一份（opWallet），不要和人物帳戶搶。
  if (opWallet.nonce < 0) opWallet.nonce = await pub.getTransactionCount({ address: operator.address });
  const hash = await opClient.sendTransaction({ to: p.address, value: GAS_TOPUP, nonce: opWallet.nonce });
  opWallet.nonce += 1;
  await pub.waitForTransactionReceipt({ hash });
  return w;
}

async function registerKyc(p, now) {
  const w = await ensureFunded(p);
  const nonce = await pub.readContract({ address: D.kycRegistry, abi: kycAbi, functionName: "nonces", args: [p.address] });
  const a = {
    account: p.address,
    tier: TIER[p.tier],
    expiry: BigInt(now + 3 * 365 * 86400),
    jurisdiction: toHex(Buffer.from(p.country, "utf8")),
    identityHash: keccak256(toBytes(`${p.country}-SIM-${p.id}-${p.name}`)),
    nonce,
    deadline: BigInt(now + 365 * 86400),
  };
  const signature = await operator.signTypedData({
    domain: { name: "CO2Exchange KYCRegistry", version: "1", chainId, verifyingContract: D.kycRegistry },
    types: {
      IdentityAttestation: [
        { name: "account", type: "address" }, { name: "tier", type: "uint8" }, { name: "expiry", type: "uint64" },
        { name: "jurisdiction", type: "bytes2" }, { name: "identityHash", type: "bytes32" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "IdentityAttestation",
    message: a,
  });
  await send(w, { address: D.kycRegistry, abi: kycAbi, functionName: "register", args: [a, signature] });

  // 入金（模擬：信託專戶入帳後平台鑄出等額結算幣）
  const budget = BigInt(Math.max(20_000, p.annualNeedTonnes * 1200 + 50_000)) * 10n ** 6n;
  await send(opWallet, { address: D.settlementToken, abi: erc20Abi, functionName: "mint", args: [p.address, budget] });
  cash.set(p.address, budget);
  // 一次把授權做完，之後的每一筆買賣就只剩一個動作
  await send(w, { address: D.settlementToken, abi: erc20Abi, functionName: "approve", args: [D.listing, 2n ** 255n] });
  await send(w, { address: D.carbonCredit1155, abi: creditAbi, functionName: "setApprovalForAll", args: [D.listing, true] });
  p.joined = true;
}

async function topUp(p) {
  const amount = BigInt(Math.max(50_000, p.annualNeedTonnes * 600)) * 10n ** 6n;
  await send(opWallet, { address: D.settlementToken, abi: erc20Abi, functionName: "mint", args: [p.address, amount] });
  cash.set(p.address, (cash.get(p.address) ?? 0n) + amount);
}

// ───────────────────────── 行為 ─────────────────────────

const rndInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/// 專案方：登錄專案 → 由查驗機構簽章核發 → 額度進到自己手上
async function actIssue(p, now, rng) {
  const w = walletOf(p);
  if (!p.projectId) {
    p.projectId = await send(w, {
      address: D.carbonRegistry, abi: registryAbi, functionName: "registerProject",
      args: [p.projectName, p.project.methodology, `${p.city}, ${p.country}`, `ipfs://sim/${p.id}`],
    }, true);
  }
  // 一個專案一年核發不出比它實際減下來更多的量。沒有這條限制，模擬器會無限印額度，
  // 掛單簿變成一面永遠填不完的牆——那不是市場，那是水龍頭。
  const year = new Date(now * 1000).getUTCFullYear();
  if (p.issuedYear !== year) { p.issuedYear = year; p.issuedTonnes = 0; }
  const remainTonnes = p.projectScaleTonnes - p.issuedTonnes;
  if (remainTonnes < 200) return false;
  // 市價低於成本就先不送查驗。查驗是要花錢的，核發出來也賣不掉。
  if (p.costPerTonne && Number(refPrice) < p.costPerTonne * 1e6 * 0.95 && rng() < 0.85) return false;
  const lot = Math.min(remainTonnes, rndInt(rng, Math.round(p.projectScaleTonnes * 0.2), Math.round(p.projectScaleTonnes * 0.5)));
  const amountKg = BigInt(lot * 1000);
  const serial = keccak256(toBytes(`SIM-${p.id}-${p.issueCount ?? 0}-${now}`));
  const a = {
    projectId: BigInt(p.projectId),
    monitoringStart: BigInt(now - 365 * 86400),
    monitoringEnd: BigInt(now - 86400),
    amountKg,
    serialHash: serial,
    reportHash: keccak256(toBytes(`ISO14064-3 report ${p.id}-${p.issueCount ?? 0}`)),
    attestationId: BigInt(now * 1000 + p.id),
    deadline: BigInt(now + 365 * 86400),
  };
  const signature = await operator.signTypedData({
    domain: { name: "CO2Exchange CarbonRegistry", version: "1", chainId, verifyingContract: D.carbonRegistry },
    types: {
      IssuanceAttestation: [
        { name: "projectId", type: "uint256" }, { name: "monitoringStart", type: "uint64" },
        { name: "monitoringEnd", type: "uint64" }, { name: "amountKg", type: "uint256" },
        { name: "serialHash", type: "bytes32" }, { name: "reportHash", type: "bytes32" },
        { name: "attestationId", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "IssuanceAttestation",
    message: a,
  });
  const batchId = await send(w, { address: D.carbonRegistry, abi: registryAbi, functionName: "issue", args: [a, signature] }, true);
  const id = Number(batchId);
  // 核發國一律是 TW。`registerProject` 走的是**國內**登錄路徑，合約把專案的 country
  // 寫死成 DOMESTIC；國外額度只有主權角色能用 `registerImportedProject` 帶進來。
  // 之前這裡照人物的所在地標成 JP／TH，記憶體與鏈上就對不起來——
  // 託管報告按記憶體分國、揭露頁按鏈上分國，兩邊差了七千多噸，看起來像帳不符。
  batchMeta.set(id, { country: "TW", scheme: "TCER", project: p.projectName, vintage: new Date(now * 1000).getUTCFullYear() - 1 });
  addHold(p.address, id, Number(amountKg));
  p.issueCount = (p.issueCount ?? 0) + 1;
  p.issuedTonnes += lot;
  return true;
}

/// 上架：賣方把手上的額度掛出去，價格繞著市場參考價走
async function actList(p, now, rng) {
  // 對稱的一條：簿子上已經有人出得比我想掛的價還高，就直接賣給他。
  // 不然賣單會掛在買單下面，一樣造成交叉。

  const h = hold(p.address);
  const entries = [...h.entries()].filter(([, kg]) => kg >= 1000);
  if (entries.length === 0) return false;
  const [batchId, kg] = entries[Math.floor(rng() * entries.length)];
  // 分批掛。一次把整批倒出去，簿子上就只會有兩三張大單，看起來像沒人在交易；
  // 真實的簿子是很多小單疊出來的，賣方也不會把所有貨都押在同一個價位上。
  const lotTonnes = Math.min(Math.floor(kg / 1000), rndInt(rng, 300, 2500));
  const amountKg = BigInt(Math.max(1, lotTonnes) * 1000);
  // 賣方把單鋪成一道階梯，不是全部貼著參考價掛。
  // 這一條是掛單簿有沒有厚度的關鍵：所有人都掛在成交價附近，每一張單就會被立刻吃掉，
  // 簿子上永遠只剩兩三筆——那不是「交易冷清」，那是模型少了價格分散。
  // 真實的賣方各有各的成本與耐心：急著出貨的貼著市價掛，不急的掛高了等人來。
  // 階梯要**跨在**參考價兩邊，不能整段掛在它上面。買方永遠挑最便宜的那一張，
  // 所以成交價會落在階梯底部；階梯若整段在參考價之上，每一次成交都把參考價往上帶一格，
  // 跑一年就是一路頂到上限的棘輪。跨著掛，成交把價格往下拉、簿子變薄把價格往上推，
  // 兩股力量才有得抵。
  const markup = p.role === "maker" ? 1.0 + rng() * 0.22 : 0.88 + rng() * 0.3;
  let price = clampPrice(BigInt(Math.round(Number(refPrice) * markup)));
  // 專案方不會賠本賣。價格跌到成本以下，他寧可把額度留著等明年——
  // 這是碳價的下緣，也是為什麼供給過剩不會讓價格一路跌到零。
  if (p.costPerTonne) {
    const floor = BigInt(p.costPerTonne) * 10n ** 6n;
    if (price < floor) {
      if (rng() < 0.8) return false; // 多數人收手
      price = clampPrice(floor); // 少數急需現金的照成本掛
    }
  }
  // 簿子上已經有人出得比我想掛的價還高，就直接賣給他，不要掛在他下面——
  // 那會讓最佳買價高過最佳賣價（交叉），真實市場裡不可能存在。
  const meta = batchMeta.get(batchId);
  const bestBid = [...bids.values()]
    .filter((b) => b.remainingKg >= 1000 && b.buyer.toLowerCase() !== p.address.toLowerCase())
    .filter((b) => !b.country || (meta && b.country === meta.country))
    .reduce((hi, b) => (hi === null || b.price > hi ? b.price : hi), null);
  if (bestBid !== null && bestBid >= price) return await actFillBid(p, rng);

  const w = walletOf(p);
  const orderId = await send(w, {
    address: D.listing, abi: listingAbi, functionName: "list",
    args: [BigInt(batchId), amountKg, price, 100n],
  }, true);
  orders.set(Number(orderId), { seller: p.address, batchId, remainingKg: Number(amountKg), price, minFillKg: 100 });
  addHold(p.address, batchId, -Number(amountKg));
  return true;
}

/// 「國外」有兩個不同的意思，混在一起就會寫出合約會擋下來的行為：
///
///   1. **相對於核發國**：增量抵換與環評承諾是臺灣環評制度的東西，
///      只有臺灣核發的額度有這個用途。日本的 J-Credit 拿去做增量抵換，
///      不管持有人是誰、在哪裡申報，合約都會 revert（各轄區的 purposeMask）。
///   2. **相對於持有人的申報地**：高碳洩漏風險事業在臺灣申報不得使用國外額度，
///      這是臺灣的碳費規則，看的是「申報地是不是臺灣、額度是不是臺灣核發」。
///
/// 第 1 條是合約強制的，第 2 條是申報時的規則。兩條都要遵守，但判斷基準不同。
const DOMESTIC = "TW";
const issuedAbroad = (m) => m.country !== DOMESTIC;
const foreignToPersona = (m, p) => m.country !== p.country;

/// 掛買單：出價等人來賣。買方指定核發國——他還沒有那批額度，指不了批次。
///
/// 為什麼要有這個：只有賣單的簿子是半邊的市場。想買的人只能吃現有的價，
/// 沒有地方表達「我願意出這個價、要這麼多」。真實的交易所兩邊都有掛單。
async function actPlaceBid(p, now, rng) {
  const year = new Date(now * 1000).getUTCFullYear();
  if (p.buyYear !== year) { p.buyYear = year; p.boughtThisYear = 0; }
  const quota = p.role === "maker" ? Infinity : p.annualNeedTonnes * 1.3;
  const left = quota - (p.boughtThisYear ?? 0);
  if (left < 1) return false;

  // 出價掛在參考價**之下**——買單是「我願意等，但要便宜一點」。
  // 掛在參考價之上的買單會立刻被賣方吃掉，那跟直接買沒兩樣。
  const price = clampPrice(BigInt(Math.round(Number(refPrice) * (0.9 + rng() * 0.08))));

  // 如果簿子上已經有人賣得比我想出的價還便宜，理性的買家會直接買，不會掛單等。
  // 少了這一條，買單簿的最佳買價會高過賣單簿的最佳賣價——一本**交叉**的簿子，
  // 在真實市場裡不可能存在（會馬上被套利掉），看在懂行的人眼裡就是資料假的。
  const cheapestOk = [...orders.values()]
    .filter((o) => o.remainingKg >= 1000 && o.seller.toLowerCase() !== p.address.toLowerCase())
    .filter((o) => {
      const meta = batchMeta.get(o.batchId);
      return meta && (!(p.leakageRisk && p.country === DOMESTIC) || !issuedAbroad(meta));
    })
    .reduce((lo, o) => (lo === null || o.price < lo ? o.price : lo), null);
  if (cheapestOk !== null && cheapestOk <= price) return false;
  const tonnes = Math.min(left, Math.max(1, Math.round(p.annualNeedTonnes / 10 * (0.5 + rng()))));
  const kg = BigInt(Math.round(tonnes * 1000));
  const cost = (kg * price) / 1000n;
  if ((cash.get(p.address) ?? 0n) < cost) {
    await topUp(p);
    if ((cash.get(p.address) ?? 0n) < cost) return false;
  }
  // 高碳洩漏風險事業在臺灣申報不得用國外額度，那就只掛臺灣的買單
  const country = p.leakageRisk || p.role === "eia" || rng() < 0.7 ? "TW" : "";
  // 不要在這裡 approve。註冊時已經給過 Listing 一筆極大的額度，
  // 在這裡改成「剛好 cost」會把那筆蓋掉——買單一成交額度就歸零，
  // 接下來這個人的 buy() 全部 revert。實測 595 次略過就是這麼來的。
  const w = walletOf(p);
  const bidId = await send(w, {
    address: D.listing, abi: listingAbi, functionName: "placeBid",
    args: [country ? toHex(Buffer.from(country, "utf8")) : "0x0000", kg, price, 0n],
  }, true);
  bids.set(Number(bidId), { buyer: p.address, country, remainingKg: Number(kg), price });
  cash.set(p.address, (cash.get(p.address) ?? 0n) - cost);
  return true;
}

/// 賣給一張買單。持有人的另一條出場路徑：不必掛單等人上門。
async function actFillBid(p, rng) {
  const mine = [...hold(p.address).entries()].filter(([, kg]) => kg >= 1000);
  if (mine.length === 0) return false;
  const [batchId, haveKg] = mine[Math.floor(rng() * mine.length)];
  const meta = batchMeta.get(batchId);
  if (!meta) return false;
  // 挑出價最高、而且吃得下這個批次核發國的買單
  const cand = [...bids.entries()]
    .filter(([, b]) => b.remainingKg >= 1000 && b.buyer.toLowerCase() !== p.address.toLowerCase())
    .filter(([, b]) => !b.country || b.country === meta.country)
    .sort((a, b) => Number(b[1].price - a[1].price));
  if (cand.length === 0) return false;
  const [bidId, b] = cand[0];
  // 賣方不會低於自己的成本賣（開發者）或遠低於參考價賣
  if (b.price < (refPrice * 85n) / 100n) return false;
  const kg = Math.min(haveKg, b.remainingKg, Math.round((1 + rng() * 4) * 1000));
  if (kg < 1000) return false;

  // setApprovalForAll 註冊時也給過了，不必每次再送一筆
  const w = walletOf(p);
  await send(w, { address: D.listing, abi: listingAbi, functionName: "fillBid", args: [BigInt(bidId), BigInt(batchId), BigInt(kg)] });

  b.remainingKg -= kg;
  if (b.remainingKg === 0) bids.delete(bidId);
  addHold(p.address, batchId, -kg);
  addHold(b.buyer, batchId, kg);
  const cost = (BigInt(kg) * b.price) / 1000n;
  const fee = (cost * 100n) / 10_000n;
  cash.set(p.address, (cash.get(p.address) ?? 0n) + cost - fee);
  const buyer = personas.find((x) => x.address.toLowerCase() === b.buyer.toLowerCase());
  if (buyer) buyer.boughtThisYear = (buyer.boughtThisYear ?? 0) + kg / 1000;
  refPrice = clampPrice((refPrice * 97n + b.price * 3n) / 100n);
  return true;
}

/// 買進：從掛單簿挑最便宜、而且符合自己用途的那一筆
function pickOrder(p, rng) {
  const wantForeignOk = p.foreignShare > 0 && rng() < p.foreignShare;
  const candidates = [...orders.entries()]
    .filter(([, o]) => o.remainingKg >= 100 && o.seller.toLowerCase() !== p.address.toLowerCase())
    .filter(([, o]) => {
      const m = batchMeta.get(o.batchId);
      if (!m) return false;
      // 開發案抵換只能用臺灣核發的額度——這是合約層的硬規則，不是偏好
      if (p.role === "eia" && issuedAbroad(m)) return false;
      // 高碳洩漏風險事業在臺灣申報不得使用國外額度（碳費收費辦法第 10 條）
      if (p.leakageRisk && p.country === DOMESTIC && issuedAbroad(m)) return false;
      if (foreignToPersona(m, p) && !wantForeignOk) return false;
      return true;
    })
    .sort((a, b) => Number(a[1].price - b[1].price));
  if (candidates.length === 0) return null;
  // 不總是掃最便宜的：真實買方會看專案、看年份，這裡用前三便宜隨機挑
  return candidates[Math.min(candidates.length - 1, Math.floor(rng() * Math.min(3, candidates.length)))];
}

async function actBuy(p, now, rng, date) {
  const found = pickOrder(p, rng);
  if (!found) return false;
  const [orderId, o] = found;
  // 申報季逼近時多付一點是合理的（沒買到的代價更高），但也就 15%，不是無上限。
  const urgencyNow = seasonality(p, date) > 2 ? 1.15 : 1;
  const willing = BigInt(Math.round(Number(anchorPrice) * p.priceTolerance * urgencyNow));
  if (o.price > willing) return false;

  // 年度採購預算。沒有這條，一個履約對象會整年不停地買——他手上的額度被註銷掉之後
  // 又「不夠了」，於是再買，一年下來買進的量是他實際需求的十幾倍，市場就被他抽乾。
  // 實際上買多少是年初就編好的：需求量加一點緩衝，買夠了就收手。
  const year = date.getUTCFullYear();
  if (p.buyYear !== year) { p.buyYear = year; p.boughtThisYear = 0; }
  const quota = p.role === "maker" ? Infinity : p.annualNeedTonnes * 1.3;
  if (p.boughtThisYear >= quota) return false;

  const season = seasonality(p, date);
  const baseTonnes = { compliance: p.annualNeedTonnes / 8, voluntary: p.annualNeedTonnes / 5, eia: p.annualNeedTonnes / 3, retail: Math.max(1, p.annualNeedTonnes / 4), maker: 8, developer: 0 }[p.role] ?? 2;
  let kg = Math.round(Math.max(100, baseTonnes * season * (0.5 + rng())) * 1000);
  kg = Math.min(kg, o.remainingKg, Math.round((quota - p.boughtThisYear) * 1000));
  if (kg < o.minFillKg && kg !== o.remainingKg) return false;

  const cost = (BigInt(kg) * o.price) / 1000n;
  if ((cash.get(p.address) ?? 0n) < cost) {
    await topUp(p);
    if ((cash.get(p.address) ?? 0n) < cost) return false;
  }
  await send(walletOf(p), { address: D.listing, abi: listingAbi, functionName: "buy", args: [BigInt(orderId), BigInt(kg)] });

  o.remainingKg -= kg;
  if (o.remainingKg === 0) orders.delete(orderId);
  addHold(p.address, o.batchId, kg);
  cash.set(p.address, (cash.get(p.address) ?? 0n) - cost);
  cash.set(o.seller, (cash.get(o.seller) ?? 0n) + cost);
  // 參考價跟著成交價走（EMA）。這裡刻意**不加**「買壓讓價格上漲」的項：
  // 每一筆成交都往上推一點，跑一年就必然頂到上限——那不是市場，是單向的棘輪。
  // 供需對價格的影響交給下面的掛單簿深度，那才是真的會兩邊跑的東西。
  refPrice = clampPrice((refPrice * 97n + o.price * 3n) / 100n);
  p.boughtTonnes = (p.boughtTonnes ?? 0) + kg / 1000;
  p.boughtThisYear += kg / 1000;
  return true;
}

const PURPOSE = { CarbonFee: 0, VoluntaryNeutrality: 1, IncrementOffset: 2, EiaCommitment: 3 };

/// 註銷：把額度用掉，換一張憑證。用途要跟核發國相容，否則合約會擋。
async function actRetire(p, now, rng) {
  if (p.tier !== "corporate") return false; // 自然人開不了官方額度帳戶
  const h = hold(p.address);
  const entries = [...h.entries()].filter(([, kg]) => kg >= 1000);
  if (entries.length === 0) return false;
  const [batchId, kg] = entries[Math.floor(rng() * entries.length)];
  const meta = batchMeta.get(batchId);
  if (!meta) return false;

  let purpose = { compliance: PURPOSE.CarbonFee, eia: PURPOSE.IncrementOffset, voluntary: PURPOSE.VoluntaryNeutrality, maker: PURPOSE.VoluntaryNeutrality, developer: PURPOSE.VoluntaryNeutrality }[p.role];
  // 增量抵換與環評承諾只有臺灣核發的額度有這個用途，看的是**核發國**不是持有人。
  // 之前這裡拿持有人的申報地來比，於是一家大阪的公司拿日本額度去做「增量抵換」——
  // 對他來說那是本地額度，但日本的登錄簿裡根本沒有這個用途，合約直接 revert。
  if (issuedAbroad(meta) && (purpose === PURPOSE.IncrementOffset || purpose === PURPOSE.EiaCommitment)) {
    if (p.role === "eia") return false; // 他不會拿非臺灣的額度去辦環評抵換
    purpose = PURPOSE.VoluntaryNeutrality;
  }
  const amountKg = BigInt(Math.max(1000, Math.round(kg * (0.4 + rng() * 0.6))));
  await send(walletOf(p), {
    address: D.carbonCredit1155, abi: creditAbi, functionName: "retire",
    args: [{
      holder: p.address, batchId: BigInt(batchId), amountKg, certificateTo: p.address,
      beneficiaryHash: keccak256(toBytes(`${p.country}-SIM-${p.id}`)),
      beneficiary: p.name, purpose,
      memo: `${new Date(now * 1000).getUTCFullYear()} ${["碳費扣除", "自願性碳中和", "增量抵換", "環評承諾"][purpose]}`,
    }],
  });
  addHold(p.address, batchId, -Number(amountKg));
  p.retiredTonnes = (p.retiredTonnes ?? 0) + Number(amountKg) / 1000;
  return true;
}

/// 做市商會把掛太久沒成交的單收回來重掛
async function actReprice(p, rng) {
  const mine = [...orders.entries()].filter(([, o]) => o.seller.toLowerCase() === p.address.toLowerCase());
  if (mine.length === 0) return false;
  const [orderId, o] = mine[Math.floor(rng() * mine.length)];
  await send(walletOf(p), { address: D.listing, abi: listingAbi, functionName: "cancel", args: [BigInt(orderId)] });
  orders.delete(orderId);
  addHold(p.address, o.batchId, o.remainingKg);
  return true;
}

/// 本站在各國登錄簿的託管帳戶。名稱與帳號跟 DemoFlow 的第一份對帳報告一致。
const CUSTODY = {
  TW: { custodian: "環境部 溫室氣體減量額度管理系統", ref: "TW-ACC-0001" },
  JP: { custodian: "Ｊ－クレジット登録簿", ref: "JP-ACC-0007", scheme: "J-Credit" },
  TH: { custodian: "TGO T-VER Registry", ref: "TH-ACC-0012", scheme: "T-VER" },
  AU: { custodian: "ANREU", ref: "AU-ACC-0031", scheme: "ACCU" },
  KR: { custodian: "온실가스 종합정보센터 배출권등록부", ref: "KR-ACC-0004", scheme: "KOC" },
  ID: { custodian: "SRN PPI（Sistem Registri Nasional）", ref: "ID-ACC-0019", scheme: "SPE-GRK" },
};

/// 平台進貨：本站在各國登錄簿的託管帳戶收到新的額度，對應上鏈。
/// 沒有這一段，國外額度就是部署時給的那幾十噸，賣完就再也沒有——
/// 而託管帳戶本來就是會持續進貨的，那是這門生意的一部分。
///
/// 注意：模擬器**不**登錄新的國外專案。`registerImportedProject` 要 SOVEREIGN_ROLE，
/// 那把鑰匙在國家 Safe 手上，不在營運方的熱錢包裡——這是設計，不是限制。
/// 開一個新轄區、認一個新專案是主權行為；把託管帳戶收到的額度對應上鏈是營運行為。
/// 所以這裡只往**既有的**國外專案裡進貨，新專案請由治理流程另行登錄。
async function actImportForeign(now, rng) {
  const entries = [...importedProjects.entries()];
  if (entries.length === 0) return false;
  const [, pid] = entries[Math.floor(rng() * entries.length)];
  const meta = foreignMeta.get(pid);
  if (!meta || !CUSTODY[meta.country]) return false;
  const amountKg = BigInt(rndInt(rng, 400, 3000) * 1000);
  const a = {
    projectId: BigInt(pid),
    monitoringStart: BigInt(now - 365 * 86400),
    monitoringEnd: BigInt(now - 86400),
    amountKg,
    serialHash: keccak256(toBytes(`IMP-${meta.country}-${pid}-${now}`)),
    reportHash: keccak256(toBytes(`${meta.methodology} verification ${pid}-${now}`)),
    attestationId: BigInt(now * 1000 + 900000 + pid),
    deadline: BigInt(now + 365 * 86400),
  };
  const signature = await operator.signTypedData({
    domain: { name: "CO2Exchange CarbonRegistry", version: "1", chainId, verifyingContract: D.carbonRegistry },
    types: {
      IssuanceAttestation: [
        { name: "projectId", type: "uint256" }, { name: "monitoringStart", type: "uint64" },
        { name: "monitoringEnd", type: "uint64" }, { name: "amountKg", type: "uint256" },
        { name: "serialHash", type: "bytes32" }, { name: "reportHash", type: "bytes32" },
        { name: "attestationId", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "IssuanceAttestation",
    message: a,
  });
  const batchId = await send(opWallet, { address: D.carbonRegistry, abi: registryAbi, functionName: "issue", args: [a, signature] }, true);
  const id = Number(batchId);
  batchMeta.set(id, { country: meta.country, scheme: meta.scheme, project: meta.name, vintage: new Date(now * 1000).getUTCFullYear() - 1 });
  addHold(operator.address, id, Number(amountKg));
  return true;
}

/// 每月 5 日的託管與準備金對帳報告。
///
/// 這不是裝飾。平台在首頁與契約裡都寫了「每月 5 日公開對帳」，
/// 展示資料裡卻只有部署當天那一份，跑了十個月都沒更新——
/// 那頁面看起來就是「說了做不到」。報告的託管餘額直接取鏈上即時流通量：
/// demo 環境的登錄簿餘額本來就是由鏈上推導的，所以一定對得起來；
/// 正式環境是人工填報後由查核機構簽署，兩邊對不上才是要查的事。
async function actPublishReserve(now, simNow = now) {
  // 期別是劇本的月份（縮時模式下一年會發十二期）；asOf 是鏈上真的時間。
  const d = new Date(simNow * 1000);
  const period = Number(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  if (publishedPeriods.has(period)) return false;
  publishedPeriods.add(period);

  // 各國託管餘額直接從鏈上算：核發減註銷，依核發國分組。
  // 不要用模擬器記憶體裡的持有量——那少掉掛在簿子上的、池子裡的，以及 demo 腳本
  // 留下的那幾個帳戶，報告出來會像託管帳戶短少了幾萬噸。
  // 揭露頁的「鏈上流通（即時）」也是用同一個算法自己重算一次，兩邊要對得起來。
  const byCountry = new Map();
  for (const [batchId, meta] of batchMeta) {
    const b = await pub.readContract({ address: D.carbonCredit1155, abi: creditAbi, functionName: "batchOf", args: [BigInt(batchId)] });
    const kg = Number(b.issuedKg - b.retiredKg);
    if (kg > 0) byCountry.set(meta.country, (byCountry.get(meta.country) ?? 0) + kg);
  }
  const rows = [...byCountry.entries()]
    .filter(([c]) => CUSTODY[c])
    .map(([country, kg]) => ({
      country: toHex(Buffer.from(country, "utf8")),
      custodian: CUSTODY[country].custodian,
      accountRef: CUSTODY[country].ref,
      heldKg: BigInt(kg),
      onchainKg: BigInt(kg),
      statementHash: keccak256(toBytes(`registry statement ${country} ${period}`)),
    }));
  if (rows.length === 0) return false;

  const supply = await pub.readContract({ address: D.settlementToken, abi: erc20Abi, functionName: "totalSupply" });
  const cashRow = {
    trustee: "某某商業銀行 信託部",
    accountRef: "TRUST-CO2X-001",
    balance: supply,
    tokenSupply: supply,
    statementHash: keccak256(toBytes(`trust statement ${period}`)),
  };
  const reportId = await send(opWallet, {
    address: D.reserveAttestation, abi: reserveAbi, functionName: "publish",
    args: [period, BigInt(now), rows, cashRow],
  }, true);
  await send(opWallet, {
    address: D.reserveAttestation, abi: reserveAbi, functionName: "setDocumentHash",
    args: [reportId, keccak256(toBytes(`reserve report ${period}.pdf`))],
  });
  await send(opWallet, {
    address: D.reserveAttestation, abi: reserveAbi, functionName: "attest",
    args: [reportId, 1, "某某會計師事務所", "各國託管帳戶餘額與鏈上流通量相符；信託專戶餘額與結算幣發行量相符"],
  });
  return true;
}

/// 平台把託管在各國登錄簿的國外額度分批放到市場上
async function actPlatformSupply(rng) {
  const h = hold(operator.address);
  const entries = [...h.entries()].filter(([, kg]) => kg >= 1000);
  if (entries.length === 0) return false;
  const [batchId, kg] = entries[Math.floor(rng() * entries.length)];
  const amountKg = BigInt(Math.min(kg, Math.max(1000, Math.round(kg * 0.3))));
  const meta = batchMeta.get(batchId);
  // 國外額度的報價反映當地行情：泰國便宜、日本貴
  const factor = { TH: 0.45, ID: 0.5, AU: 0.95, JP: 1.15, KR: 1.05 }[meta?.country] ?? 1;
  const price = clampPrice(BigInt(Math.round(Number(refPrice) * factor * (0.95 + rng() * 0.12))));
  const orderId = await send(opWallet, {
    address: D.listing, abi: listingAbi, functionName: "list", args: [BigInt(batchId), amountKg, price, 100n],
  }, true);
  orders.set(Number(orderId), { seller: operator.address, batchId, remainingKg: Number(amountKg), price, minFillKg: 100 });
  addHold(operator.address, batchId, -Number(amountKg));
  return true;
}

// ───────────────────────── 一輪 ─────────────────────────

let tickNo = 0;
/// `now` 是**鏈上真的會看到的時間**（attestation 的效期、deadline 都以它為準）。
/// `simNow` 是**劇本的時間**（申報季、每月對帳、人物何時加入）。
///
/// 在 anvil 上兩者相同——我們把鏈的時間調到劇本的時間。公開鏈上不行：
/// 鏈的時間就是現在，而劇本要走完一整年。所以兩個時鐘分開，
/// 凡是合約會檢查的值一律用 `now`，凡是「劇情演到哪裡」一律用 `simNow`。
/// 混用的後果很具體：拿一年前的 simNow 去算 deadline，attestation 一送上去就過期。
async function runTick(now, rng, progress, simNow = now) {
  const date = new Date(simNow * 1000);
  const stats = { join: 0, issue: 0, import: 0, list: 0, bid: 0, buy: 0, fill: 0, retire: 0, cancel: 0, report: 0 };

  // 掛單簿的深度決定供給端要多積極。薄了就補貨，厚了就收手——
  // 賣方看得到簿子，本來就會這樣反應，不必另外編一個理由。
  const depthTonnes = [...orders.values()].reduce((s2, o) => s2 + o.remainingKg, 0) / 1000;
  const thin = depthTonnes < 4000;

  // 每月 5 日的託管對帳報告。跨過那一天就發，不管當輪落在幾點。
  if (date.getUTCDate() >= 5 && await attempt("託管對帳報告", () => actPublishReserve(now, simNow))) stats.report += 1;

  // 平台進貨：託管帳戶收到新的國外額度（約每十天一批）
  if (rng() < TICK / (10 * 86400)) { if (await attempt("平台進貨", () => actImportForeign(now, rng))) stats.import += 1; }

  // 平台補貨：國外額度慢慢放，不要一次倒光
  if (rng() < (thin ? 0.25 : 0.06)) { if (await attempt("平台上架", () => actPlatformSupply(rng))) stats.list += 1; }

  for (const p of personas) {
    if (!p.joined) {
      // 回填時依 joinAt 陸續加入；持續模式一開始就全部加入
      if (progress != null && progress < p.joinAt) continue;
      if (await attempt(`${p.name} 註冊`, () => registerKyc(p, now))) stats.join += 1;
      continue; // 加入的那一輪先不動作
    }

    const season = seasonality(p, date);
    if (rng() > p.activity * season) continue;

    switch (p.role) {
      case "developer": {
        // 有貨就掛，沒貨就再核發一批。簿子薄的時候先掛貨，別讓額度躺在自己手上。
        const has = [...hold(p.address).values()].some((kg) => kg >= 1000);
        if (!has || (!thin && rng() < 0.3)) {
          if (await attempt(`${p.name} 核發`, () => actIssue(p, now, rng))) stats.issue += 1;
          else if (await attempt(`${p.name} 上架`, () => actList(p, now, rng))) stats.list += 1;
        } else {
          // 簿子上有人出得夠高就直接賣給他，省得掛單等
          if (rng() < 0.3 && await attempt(`${p.name} 賣給買單`, () => actFillBid(p, rng))) { stats.fill += 1; break; }
          // 一輪掛兩到三張，鋪在不同價位上——出貨壓力大的賣方本來就會這樣掛。
          for (let k = 0; k < (thin ? 3 : 2); k++) {
            if (await attempt(`${p.name} 上架`, () => actList(p, now, rng))) stats.list += 1;
            else break;
          }
        }
        break;
      }
      case "maker": {
        // 做市商兩邊都掛——這本來就是做市：買賣兩側同時報價、賺價差。
        const r = rng();
        if (r < 0.3) { if (await attempt(`${p.name} 買進`, () => actBuy(p, now, rng, date))) stats.buy += 1; }
        else if (r < 0.5) { if (await attempt(`${p.name} 掛買單`, () => actPlaceBid(p, now, rng))) stats.bid += 1; }
        else if (r < 0.85) { if (await attempt(`${p.name} 上架`, () => actList(p, now, rng))) stats.list += 1; }
        else if (await attempt(`${p.name} 改價`, () => actReprice(p, rng))) stats.cancel += 1;
        break;
      }
      default: {
        const held = [...hold(p.address).values()].reduce((s, kg) => s + kg, 0) / 1000;
        const needMore = held < p.annualNeedTonnes * 0.5;
        // 申報季而且手上有貨 → 註銷；其他時候以買進為主
        if (!needMore && held >= 1 && p.tier === "corporate" && seasonality(p, date) > 2 && rng() < 0.5) {
          if (await attempt(`${p.name} 註銷`, () => actRetire(p, now, rng))) stats.retire += 1;
        } else if (p.role === "retail" && held >= 1 && rng() < 0.25) {
          // 手上有貨又剛好有人出得夠高，就直接賣給買單，不必掛單等
          if (rng() < 0.4 && await attempt(`${p.name} 賣給買單`, () => actFillBid(p, rng))) stats.fill += 1;
          else if (await attempt(`${p.name} 賣出`, () => actList(p, now, rng))) stats.list += 1;
        } else if (needMore && rng() < 0.25 && await attempt(`${p.name} 掛買單`, () => actPlaceBid(p, now, rng))) {
          // 有時候不追價，掛一張買單在下面等
          stats.bid += 1;
        } else if (await attempt(`${p.name} 買進`, () => actBuy(p, now, rng, date))) {
          stats.buy += 1;
        }
        break;
      }
    }
  }

  // 掛單簿的厚薄決定價格往哪邊走：貨堆著賣不掉就得降價，貨不夠就有人願意出更高。
  // 這是雙向的，所以價格會回頭；只有「買壓推升」那一項的話，跑久了一定貼著上限。
  const TARGET_DEPTH = 8000; // 噸。市場覺得「夠深」的水位
  const depthNow = [...orders.values()].reduce((s2, o) => s2 + o.remainingKg, 0) / 1000;
  const pressure = Math.max(-1, Math.min(1, (TARGET_DEPTH - depthNow) / TARGET_DEPTH));
  refPrice = clampPrice(refPrice + BigInt(Math.round(Number(refPrice) * (0.003 * pressure + (rng() - 0.5) * 0.004))));
  // 錨價每輪只走參考價的 0.5%：一個月（約 90 輪）追得上，一週的急漲追不上。
  anchorPrice = (anchorPrice * 199n + refPrice) / 200n;
  tickNo += 1;
  if (!QUIET || tickNo % 40 === 0) {
    const line = Object.entries(stats).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(" ");
    console.log(
      `[${date.toISOString().slice(0, 16).replace("T", " ")}] 參考價 ${(Number(refPrice) / 1e6).toFixed(0)} ` +
      `賣單 ${orders.size} 買單 ${bids.size} ${line || "（無動作）"}`,
    );
  }
}

// ───────────────────────── 主流程 ─────────────────────────

// 行為的亂數跟人物的亂數分開：換模擬區間不會改變人物設定
const rng = mulberry32(`${SEED}-behaviour`);

await loadMarket();
opWallet.nonce = await pub.getTransactionCount({ address: operator.address });
cash.set(operator.address, await pub.readContract({ address: D.settlementToken, abi: erc20Abi, functionName: "balanceOf", args: [operator.address] }));

const s = rosterSummary(personas);
console.log(`模擬器啟動：${s.total} 個帳戶（seed=${SEED}，虛構人物）`);
console.log(`  角色：${s.roles.map(([k, v]) => `${k}×${v}`).join("、")}`);
console.log(`  申報地：${s.countries.map(([k, v]) => `${k}×${v}`).join("、")}`);
console.log(`  既有賣單 ${orders.size} 筆、買單 ${bids.size} 筆、已知批次 ${batchMeta.size} 個\n`);

// 人物名冊寫成檔案，介面上看到誰在買賣時可以對照
const rosterPath = path.resolve(process.cwd(), "data", "sim-personas.json");
fs.mkdirSync(path.dirname(rosterPath), { recursive: true });
fs.writeFileSync(rosterPath, JSON.stringify({
  note: "模擬用虛構人物，與任何真實公司或個人無關",
  seed: SEED,
  generatedAt: new Date().toISOString(),
  // account 是 viem 的簽章物件，序列化沒有意義（而且裡面有私鑰推導的東西）
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  personas: personas.map(({ account, ...p }) => p),
}, null, 2));

if (FROM) {
  // ── 回填模式 ──
  const fromTs = Math.floor(new Date(FROM.length <= 10 ? `${FROM}T00:00:00Z` : FROM).getTime() / 1000);
  if (!Number.isFinite(fromTs)) { console.error(`看不懂的起點時間：${FROM}`); process.exit(1); }
  const head = await chainNow();
  if (TIME_TRAVEL && fromTs < head) {
    const wantDays = Math.ceil((Date.now() / 1000 - fromTs) / 86400);
    console.error(
      `起點 ${FROM} 比鏈上現在的時間還早（鏈上是 ${new Date(head * 1000).toISOString().slice(0, 16)}）。\n` +
      `區塊時間只能往前走，不能倒退。要回填這一段，anvil 得從那時候起算：\n\n` +
      `  anvil --timestamp $(( $(date +%s) - ${wantDays}*86400 ))\n\n` +
      `然後重新部署（forge script script/DemoFlowV4.s.sol --rpc-url anvil --broadcast --sig "demo()"）再跑這支腳本。`,
    );
    process.exit(1);
  }
  const target = Math.floor(Date.now() / 1000);
  const ticks = Math.max(1, Math.ceil((target - fromTs) / TICK));

  const t0 = Date.now();
  if (TIME_TRAVEL) {
    console.log(`回填 ${new Date(fromTs * 1000).toISOString().slice(0, 10)} → 現在，共 ${ticks} 輪（每輪 ${TICK / 3600} 小時）\n`);
    for (let i = 0; i < ticks; i++) {
      const now = Math.min(target, fromTs + i * TICK);
      await setChainTime(now);
      await runTick(now, rng, i / ticks);
    }
  } else {
    // ── 縮時模式（公開鏈）──
    //
    // 鏈的時間調不動，所以改成：劇本照樣走一年，但交易全部發生在**現在**。
    // 換來的是一份「行為上是一整年、時間戳上是這幾天」的市場——
    // 首頁的量能、各國佔比、掛單結構都對，K 線的橫軸則是真實日期。
    // 想要橫軸也拉長，就把 --pace 調大並讓它跑好幾天（見 README）。
    console.log(
      `縮時模式：這條鏈（chainId ${chainId}）不能調整區塊時間，所以劇本的一年會壓縮成現在這一段時間。\n` +
      `  劇本 ${new Date(fromTs * 1000).toISOString().slice(0, 10)} → ${new Date(target * 1000).toISOString().slice(0, 10)}，共 ${ticks} 輪\n` +
      `  每輪之間實際等待 ${PACE} 秒${PACE ? `（整趟約 ${((ticks * PACE) / 3600).toFixed(1)} 小時）` : "（不等待）"}\n` +
      `  gas 撥款：每個帳戶 ${Number(GAS_TOPUP) / 1e18} ETH，最多 ${personas.length} 個\n`,
    );
    for (let i = 0; i < ticks; i++) {
      const simNow = Math.min(target, fromTs + i * TICK);
      await runTick(await chainNow(), rng, i / ticks, simNow);
      if (PACE && i < ticks - 1) await new Promise((r) => setTimeout(r, PACE * 1000));
    }
  }
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n回填完成：${sent} 筆交易、${failed} 次略過，耗時 ${mins} 分鐘。`);
  console.log(`人物名冊：web/data/sim-personas.json`);
} else {
  // ── 持續模式 ──
  console.log(`持續模式：每 ${INTERVAL} 秒一輪，依真實時間推進。Ctrl-C 結束。\n`);
  let stop = false;
  process.on("SIGINT", () => { stop = true; console.log("\n收到中斷，跑完這一輪就停。"); });
  while (!stop) {
    const now = await chainNow();
    await runTick(now, rng, null);
    if (stop) break;
    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  }
  console.log(`結束：${sent} 筆交易、${failed} 次略過。`);
}
