#!/usr/bin/env node
// 帳本 v2 的展示資料：一群虛構人物在帳本裡登錄、核發、掛單、成交、註銷，外加每月對帳報告。
//
//   cd web && node --experimental-strip-types scripts/ledger-seed.mjs --days 60 --users 40
//
// **只在本機鏈上用**（入金由本機營運 Safe 的公開測試金鑰確認，錢是虛構的）。公開鏈上的展示資料由後台做市
// 與模擬器在第 5 期改送簽名委託單後產生。
//
// 每一筆都是真的簽章事件，經過引擎規則；入金是營運 Safe 在鏈上的確認（模擬的匯款）、帳本以鏈上事件鏡像入帳。
// 事件的邏輯時間回溯到 --days 天前，讓行情圖有歷史；收單區塊高度是現在（它們確實是現在才收的）。
import path from "node:path";
import fs from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { buildPersonas, mulberry32 } from "./personas.mjs";
import { ANVIL_MNEMONIC, keyring, setting } from "./lib/keys.mjs";

const { openStore } = await import("../lib/ledger/store.ts");
const { apply, genesis } = await import("../lib/ledger/engine.ts");
const { authTypedData, userTypedData, userMessageOf } = await import("../lib/ledger/typed.ts");
const { readCashEvents, readAuthorities } = await import("../lib/ledger/chain.ts");
const { bankRefOf, creditDepositCall, execOperatorSafe, localOperatorOwners } = await import("../lib/ledger/fiat.ts");
const { activeKeys, thresholdAt } = await import("../lib/ledger/authorities.ts");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const DAYS = Number(arg("days", 60));
const USERS = Number(arg("users", 40));
const SEED = arg("seed", "co2x-ledger");

const RPC = setting("RPC_URL") ?? "http://127.0.0.1:28545";
const pub0 = createPublicClient({ transport: http(RPC) });
const chainId = await pub0.getChainId();
if (chainId !== 31337 && chainId !== 1337) { console.error(`chainId ${chainId} 不是本機鏈。這支腳本用本機營運 Safe 的公開測試金鑰確認入金，只在本機用。`); process.exit(1); }
const chain = defineChain({ id: chainId, name: "local", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 50 });
const D = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`), "utf8"));
if ((D.ledgerVersion ?? 0) < 3) { console.error("部署檔不是目前版本的帳本（需要 ledgerVersion 3）。請重新部署"); process.exit(1); }
const domains = { chainId, ledger: D.ledger };

const ring = keyring({ chainId, isLocal: true });
const op = privateKeyToAccount(ring.require("DEPLOYER_PK", "RELAYER_PK").pk);
const pick = (...names) => privateKeyToAccount(ring.optional({ pk: ring.require("DEPLOYER_PK").pk }, ...names).pk);
const idv = pick("IDENTITY_VERIFIER_PK"), cv = pick("CARBON_VERIFIER_PK"), doc = pick("DOCUMENT_SIGNER_PK"), receipt = pick("RELAYER_PK");
// 主權與營運角色是 k-of-n（簽章模型方案 B）：本機鏈上用 anvil 助記詞的帳戶湊齊門檻。
// 部署時登記的是 Safe 持有人的 EOA（DeployLedger 預設 anvil 5、6、7 與 8、9），可能另加 SOVEREIGN_SIGNER／OPERATOR_SIGNER。
const AUTH = await readAuthorities(pub0, D.ledger, { fromBlock: BigInt(D.deployedAtBlock ?? 0) });
const LOCAL_KEYS = Array.from({ length: 10 }, (_, i) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }));
function signersFor(role) {
  const at = BigInt(Number.MAX_SAFE_INTEGER);
  const keys = new Set(activeKeys(AUTH, role, at).map((a) => a.toLowerCase()));
  const k = thresholdAt(AUTH, role, at);
  const ss = LOCAL_KEYS.filter((a) => keys.has(a.address.toLowerCase())).slice(0, k);
  if (ss.length < k) { console.error(`${role} 需要 ${k} 個簽章，但本機只找得到 ${ss.length} 把登記過的 anvil 金鑰`); process.exit(1); }
  return ss;
}
const sovereign = signersFor("SOVEREIGN");
const operator = signersFor("OPERATOR");

const DATA = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
const store = openStore(process.env.LEDGER_DIR ?? path.join(DATA, "ledger"));
const personas = buildPersonas(USERS, SEED);
const mnemonic = process.env.SIM_MNEMONIC ?? ANVIL_MNEMONIC;
for (const p of personas) { p.account = mnemonicToAccount(mnemonic, { addressIndex: p.walletIndex }); p.address = p.account.address; }
// 名冊：網站靠它在掛單簿上標「模擬」，做市程式靠它避開平台自己的帳戶（和 ledger-sim.mjs 同一份格式、同一批人）
{
  const rosterPath = path.join(DATA, "sim-personas.json");
  fs.mkdirSync(DATA, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const current = personas.map(({ account, ...p }) => ({ ...p, active: true }));
  fs.writeFileSync(rosterPath, JSON.stringify({
    note: "模擬用虛構人物，與任何真實公司或個人無關", seed: SEED, chainId, generatedAt: new Date().toISOString(), personas: current,
    addressSpace: Array.from({ length: Math.max(USERS, 100) }, (_, i) => mnemonicToAccount(mnemonic, { addressIndex: 100 + i }).address),
  }, null, 2));
}

// ── 入金：本機營運 Safe 確認（虛構的新台幣，bankRef 以 seed: 開頭）──
const opW = createWalletClient({ account: op, chain, transport: http(RPC) });
const owners = localOperatorOwners();
const buyers = personas.filter((p) => p.role !== "developer");
for (const p of buyers) {
  const budget = BigInt(Math.max(30_000, p.annualNeedTonnes * 1_500)) * 1_000_000n;
  const call = creditDepositCall(D.ledger, p.address, budget, bankRefOf("in", `seed:${p.address}:${SEED}:${Date.now()}`));
  await execOperatorSafe({ pub, sender: opW, safe: D.operatorSafe, to: call.to, data: call.data, owners });
}
console.log(`  ${buyers.length} 個買方入金（營運 Safe 確認）`);

// ── 事件：一邊寫進帳本、一邊跑引擎，後面的決策才看得到前面的結果 ──
const state = genesis();
const atBlock = await pub.getBlockNumber({ cacheTime: 0 });
const t0 = BigInt(Math.floor(Date.now() / 1000) - DAYS * 86400);
let clock = t0;
let n = 0, rejected = 0;
async function put(e) {
  const { event } = await store.append({ atBlock, ...e }, { receiptSigner: receipt, at: clock });
  const before = state.rejected.length;
  apply(state, [event], { sigOk: () => true });
  if (state.rejected.length > before) rejected += 1;
  n += 1;
  return event;
}
/// `signer` 可以是一把金鑰或一組（k-of-n：每位持有人各簽一次，簽章接在一起）
async function auth(signer, kind, body) {
  const list = Array.isArray(signer) ? signer : [signer];
  const draft = { seq: 0n, at: 0n, atBlock, kind, ...body, signer: list[0].address, signature: "0x" };
  const sigs = [];
  for (const a of list) sigs.push(await a.signTypedData(authTypedData(domains, draft)));
  draft.signature = `0x${sigs.map((x) => x.slice(2)).join("")}`;
  const { seq: _s, at: _a, ...rest } = draft; void _s; void _a;
  return put(rest);
}
async function user(p, kind, body) {
  const nonce = (state.nonces.get(p.address.toLowerCase()) ?? 0n) + 1n;
  const draft = { seq: 0n, at: 0n, atBlock, kind, account: p.address, nonce, ...body, signature: "0x" };
  draft.signature = await p.account.signTypedData(userTypedData(domains, kind, userMessageOf(draft)));
  const { seq: _s, at: _a, ...rest } = draft; void _s; void _a;
  return put(rest);
}

// 帳本若已經有東西，就接在後面（鏈上存入重複鏡像會被 txHash 擋掉）
const existing = store.read();
if (existing.length) apply(state, existing, { sigOk: () => true });
const mirrored = new Set(existing.filter((e) => e.ref).map((e) => `${e.ref.txHash}:${e.ref.logIndex}`));
for (const c of await readCashEvents(pub, D.ledger, { fromBlock: BigInt(D.deployedAtBlock ?? 0) })) {
  if (mirrored.has(`${c.ref.txHash}:${c.ref.logIndex}`)) continue;
  await put(c);
}

await auth(sovereign, "policy", { individualTransfer: true, individualRetire: false, treasury: op.address });
for (const [country, name, scheme, registryName] of [
  ["JP", "日本", "J-Credit", "J-クレジット登録簿"], ["TH", "泰國", "T-VER", "T-VER Registry"],
  ["KR", "韓國", "KOC", "온실가스 종합정보센터"], ["AU", "澳洲", "ACCU", "ANREU"],
]) await auth(sovereign, "jurisdiction", { country, enabled: true, domestic: false, purposeMask: 0x03, name, scheme, registryName, note: "國外額度：僅可用於碳費扣除與自願性碳中和" });
await auth(operator, "fees", { country: "", tradeBps: 100n, retireFeePerTonne: 20_000_000n });

for (const p of personas) {
  await auth(idv, "identity", {
    account: p.address, tier: p.tier === "individual" ? 1 : 2, expiry: t0 + 3n * 365n * 86400n, jurisdiction: p.country,
    identityHash: keccak256(toBytes(`sim:${p.id}:${p.name}`)), nonce: 0n, deadline: t0 + 86400n,
  });
}
const devs = personas.filter((p) => p.role === "developer");
for (const p of devs) await user(p, "project", { name: p.projectName, methodology: p.project.methodology, location: `${p.city}, ${p.country}`, metadataURI: `ipfs://sim/${p.id}` });
await auth(sovereign, "importProject", { owner: op.address, country: "JP", scheme: "J-Credit", name: "北海道 森林經營", methodology: "FO-001", location: "北海道", metadataURI: "" });
await auth(sovereign, "importProject", { owner: op.address, country: "TH", scheme: "T-VER", name: "清邁 稻殼發電", methodology: "T-VER-S-METH-01", location: "清邁", metadataURI: "" });

const rng = mulberry32(`${SEED}-market`);
let ref = 800;
let attId = 1n;
const projectOf = (p) => [...state.projects.values()].find((x) => x.owner.toLowerCase() === p.address.toLowerCase());
const holdings = (addr) => [...(state.credits.get(addr.toLowerCase()) ?? new Map()).entries()].map(([id, kg]) => ({ id: BigInt(id), kg }));
const P = (x) => BigInt(Math.round(x)) * 1_000_000n;

for (let day = 0; day < DAYS; day++) {
  clock = t0 + BigInt(day) * 86400n + 3600n;
  const date = new Date(Number(clock) * 1000);
  // 核發：每個專案方每 20 天左右一批
  for (const [i, p] of devs.entries()) {
    if ((day + i * 3) % 20 !== 0) continue;
    const pr = projectOf(p);
    if (!pr) continue;
    await auth(cv, "issue", {
      projectId: pr.id, monitoringStart: clock - 365n * 86400n, monitoringEnd: clock - 86400n,
      amountKg: BigInt(Math.round(p.projectScaleTonnes * (0.15 + rng() * 0.2)) * 1000),
      serialHash: keccak256(toBytes(`${SEED}-serial-${attId}`)), reportHash: keccak256(toBytes(`${SEED}-report-${attId}`)), attestationId: attId, deadline: clock + 86400n,
    });
    attId += 1n;
  }
  if (day % 25 === 3) {
    for (const pid of [...state.projects.values()].filter((x) => x.country !== "TW").map((x) => x.id)) {
      await auth(cv, "issue", { projectId: pid, monitoringStart: clock - 365n * 86400n, monitoringEnd: clock - 86400n, amountKg: 3_000_000n, serialHash: keccak256(toBytes(`${SEED}-imp-${attId}`)), reportHash: keccak256(toBytes(`${SEED}-imp-${attId}`)), attestationId: attId, deadline: clock + 86400n });
      attId += 1n;
    }
  }
  // 賣方掛單：專案方與平台（國外額度）
  for (const p of [...devs, { address: op.address, account: op, isOp: true }]) {
    for (const h of holdings(p.address)) {
      if (h.kg < 1000n || rng() > 0.5) continue;
      const kg = (h.kg * BigInt(20 + Math.floor(rng() * 30))) / 100n;
      // 專案方不會賠本賣：成本是價格的下緣（和舊模擬器同一條規則）；國外額度依當地行情便宜一些
      const price = Math.max(p.isOp ? 300 : (p.costPerTonne ?? 450), ref * (0.95 + rng() * 0.2) * (p.isOp ? 0.85 : 1));
      if (p.isOp) {
        // 平台自己也是市場參與者：營運金鑰要有身分才能掛單
        if (!state.identities.get(op.address.toLowerCase())) await auth(idv, "identity", { account: op.address, tier: 2, expiry: t0 + 3n * 365n * 86400n, jurisdiction: "TW", identityHash: keccak256(toBytes("platform")), nonce: 0n, deadline: clock + 86400n });
        await user({ address: op.address, account: op }, "place", { side: "sell", batchId: h.id, country: "", amountKg: kg, pricePerTonne: P(price), minFillKg: 100n, expiry: clock + 30n * 86400n });
      } else {
        await user(p, "place", { side: "sell", batchId: h.id, country: "", amountKg: kg, pricePerTonne: P(price), minFillKg: 100n, expiry: clock + 30n * 86400n });
      }
    }
  }
  // 買方：依活躍度下單；價格繞著參考價
  for (const p of buyers) {
    clock += 60n;
    if (rng() > p.activity * 2) continue;
    const tonnes = Math.max(1, Math.round((p.annualNeedTonnes || 50) / 30 * (0.5 + rng())));
    const country = p.leakageRisk || p.role === "eia" ? "TW" : "";
    const price = ref * (0.95 + rng() * 0.15) * p.priceTolerance;
    await user(p, "place", { side: "buy", batchId: 0n, country, amountKg: BigInt(tonnes * 1000), pricePerTonne: P(price), minFillKg: 0n, expiry: clock + 7n * 86400n });
  }
  // 註銷：法人買方每兩週註銷手上的一部分
  if (day % 14 === 10) {
    for (const p of buyers.filter((x) => x.tier === "corporate" && x.role !== "maker")) {
      for (const h of holdings(p.address)) {
        if (h.kg < 1000n) continue;
        const country = state.projects.get(String(state.batches.get(String(h.id)).projectId)).country;
        const purpose = p.role === "eia" ? (country === "TW" ? 2 : 1) : p.role === "compliance" ? 0 : 1;
        await user(p, "retire", { batchId: h.id, amountKg: h.kg / 2n, beneficiary: p.name, beneficiaryHash: keccak256(toBytes(`ben:${p.id}`)), purpose, memo: `${date.getUTCFullYear()} 申報` });
      }
    }
  }
  // 每月 5 日的對帳報告
  if (date.getUTCDate() === 5) {
    const byCountry = new Map();
    for (const b of state.batches.values()) {
      const c = state.projects.get(String(b.projectId)).country;
      byCountry.set(c, (byCountry.get(c) ?? 0n) + b.issuedKg - b.retiredKg);
    }
    const period = Number(`${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
    const credits = [...byCountry.entries()].map(([country, kg]) => ({ country, custodian: country === "TW" ? "環境部 溫室氣體減量額度管理系統" : `${country} 國家登錄簿`, accountRef: `${country}-ACC-001`, heldKg: kg, ledgerKg: kg, statementHash: keccak256(toBytes(`stmt ${country} ${period}`)) }));
    const cashTotal = [...state.cash.values(), ...state.lockedCash.values()].reduce((a, b) => a + b, 0n) + state.treasuryCash;
    await auth(doc, "reserveReport", { period, asOf: clock, credits, cash: { trustee: "某某商業銀行 信託部", accountRef: "TRUST-001", balance: cashTotal, tokenSupply: cashTotal, statementHash: keccak256(toBytes(`trust ${period}`)) }, documentHash: keccak256(toBytes(`report ${period}`)) });
    await auth(cv, "reserveAttest", { reportId: state.nextReportId - 1n, status: 1, auditorName: "某某會計師事務所", note: "託管餘額與帳本流通量相符" });
  }
  // 參考價跟著成交走
  // 參考價只看國內額度的成交：平台放出的國外額度依當地行情便宜得多，混進來會把國內價格一路拖低
  const recent = state.fills.filter((f) => f.country === "TW").slice(-10);
  if (recent.length) ref = recent.reduce((s, f) => s + Number(f.pricePerTonne) / 1e6, 0) / recent.length * (0.995 + rng() * 0.02);
  ref = Math.min(2200, Math.max(400, ref));
}

console.log(`  帳本 ${store.head().seq} 筆（本次 ${n} 筆，被規則拒絕 ${rejected} 筆）；成交 ${state.fills.length} 筆、憑證 ${state.certificates.size} 張、掛單 ${state.book.size} 張`);
