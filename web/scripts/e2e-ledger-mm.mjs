#!/usr/bin/env node
// 做市與模擬器 × 帳本的端到端測試（本機 anvil，設計 v4 第 5 期）。
//
//   anvil --port 38548 &
//   npm run test:ledger-mm
//
// 走一遍：部署帳本合約 → 回填一小段展示資料 → 做市跑一輪（身分、撥款入金、報價）→ 模擬器跑幾輪 →
// 一位真實使用者把額度賣給做市的買價 → 收回資金 → 承諾上鏈、查核者重播全部通過。
//
// 驗的是這一期的三個保證：
//   ① 做市帳戶只被動報價：它**從來不是**任何一筆成交的吃單方
//   ② 做市帳戶不和平台控制的帳戶成交：模擬人物與做市帳戶之間沒有任何一筆成交
//   ③ 做市與模擬器寫的每一筆都是真的簽章事件：承諾與查核（離線重驗簽章）都過
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { openStore } = await import("../lib/ledger/store.ts");
const { createAgent } = await import("../lib/ledger/agent.ts");

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:38548";
const ROOT = path.resolve(process.cwd(), "..");
const pub = createPublicClient({ transport: http(RPC) });
const chainId = await pub.getChainId().catch(() => { console.error(`連不上 ${RPC}（先開 anvil --port 38548）`); process.exit(1); });
if (chainId !== 31337) { console.error("只在本機 anvil（31337）上跑"); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "co2x-mm-"));
const DEP = path.join(TMP, "deploy.json");
const DATA = path.join(TMP, "data");
// anvil 的預設帳戶——只在本機鏈上用。#0 部署者（也是展示用的主權／營運簽章者）、#3 一位真實使用者
const A0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const USER_PK = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

// ── 部署（不蓋掉開發用的部署檔）──
const depFile = path.join(ROOT, "deployments", "31337.json");
const backup = fs.existsSync(depFile) ? fs.readFileSync(depFile) : null;
execSync(`forge script script/DeployLedger.s.sol --rpc-url ${RPC} --broadcast`, {
  cwd: ROOT, stdio: "pipe",
  env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}`, SOVEREIGN_SIGNER: A0, OPERATOR_SIGNER: A0 },
});
fs.copyFileSync(depFile, DEP);
if (backup) fs.writeFileSync(depFile, backup);
const D = JSON.parse(fs.readFileSync(DEP, "utf8"));
console.log(`  部署 Ledger ${D.ledger}`);

const env = {
  ...process.env, RPC_URL: RPC, DEPLOYMENT_FILE: DEP, DATA_DIR: DATA, MM_KEY_FILE: path.join(TMP, "mm.env"),
  CHAIN_ID: "31337", ENV_FILE: path.join(TMP, "none.env"),
};
const node = (script, args = []) => execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const mmConfig = (c) => { fs.mkdirSync(path.join(DATA, "mm"), { recursive: true }); fs.writeFileSync(path.join(DATA, "mm", "config.json"), JSON.stringify(c)); };
const status = () => JSON.parse(fs.readFileSync(path.join(DATA, "mm", "status.json"), "utf8"));
const store = openStore(path.join(DATA, "ledger"));
const agent = createAgent({ store, client: pub, domains: { chainId, ledger: D.ledger }, receiptSigner: privateKeyToAccount(USER_PK) });
const low = (a) => a.toLowerCase();

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

// ── 展示資料 ──
node("scripts/ledger-seed.mjs", ["--days", "8", "--users", "12"]);
ok(`回填展示資料（帳本 ${store.head().seq} 筆）`);

// ── 做市第一輪 ──
const cfg = { enabled: true, capitalTWD: 300000, maxInventoryTonnes: 200, maxOrderTonnes: 20, levels: 2, spreadBps: 400, stepBps: 150, intervalSec: 60 };
mmConfig(cfg);
node("scripts/mm/mm.mjs", ["--once"]);
let st = status();
const MM = low(st.marketMaker);
let s = agent.state();
assert.ok(s.identities.get(MM)?.tier === 2, "做市帳戶有法人身分");
ok("做市帳戶的身分由身分驗證金鑰登記進帳本");
assert.equal(BigInt(Math.round(st.cash * 1e6)) + BigInt(Math.round(st.bidEscrow * 1e6)), 300000n * 1_000_000n);
ok("撥款 300,000 元：鏈上存進帳本合約、鏡像進帳本（現金＋買單鎖定 = 撥款）");
assert.ok(st.quotes.bids.length > 0, "有買價");
ok(`掛出 ${st.quotes.bids.length} 檔買價（沒有庫存，所以還沒有賣價）`);

// ── 模擬器 ──
node("scripts/ledger-sim.mjs", ["--users", "12", "--interval", "1", "--ticks", "4", "--avoid", MM]);
node("scripts/mm/mm.mjs", ["--once"]);
s = agent.state();
const personas = new Set(JSON.parse(fs.readFileSync(path.join(DATA, "sim-personas.json"), "utf8")).personas.map((p) => low(p.address)));
const simVsMm = s.fills.filter((f) => (low(f.buyer) === MM && personas.has(low(f.seller))) || (low(f.seller) === MM && personas.has(low(f.buyer))));
assert.equal(simVsMm.length, 0, "模擬人物不能和做市帳戶成交");
ok(`模擬器跑 4 輪（帳本 ${store.head().seq} 筆），模擬人物與做市帳戶之間 0 筆成交`);

// ── 一位真實使用者把額度賣給做市帳戶的買價 ──
// 他需要身分與額度：身分由身分驗證金鑰（本機部署 = anvil #0）登記，額度向一位模擬專案方買
const user = privateKeyToAccount(USER_PK);
const idv = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const t = BigInt(Math.floor(Date.now() / 1000));
await agent.authority(idv, "identity", { account: user.address, tier: 2, expiry: t + 86400n * 30n, jurisdiction: "TW", identityHash: `0x${"ab".repeat(32)}`, nonce: 0n, deadline: t + 3600n });
// 額度：他自己登錄一個專案、由查驗機構（本機部署 = anvil #0）核發一批給他
await agent.user(user, "project", { name: "e2e 測試專案", methodology: "AMS-I.D", location: "臺南", metadataURI: "" });
const pid = [...agent.state().projects.values()].find((p) => low(p.owner) === low(user.address)).id;
await agent.authority(idv, "issue", {
  projectId: pid, monitoringStart: t - 86400n * 365n, monitoringEnd: t - 86400n, amountKg: 2_000_000n,
  serialHash: `0x${"cd".repeat(32)}`, reportHash: `0x${"ef".repeat(32)}`, attestationId: 999_001n, deadline: t + 3600n,
});
s = agent.state();
const batch = [...(s.credits.get(low(user.address)) ?? new Map()).keys()][0];
assert.ok(batch, "使用者拿到核發的額度");
const bestMmBid = [...s.book.values()].filter((o) => low(o.account) === MM && o.side === "buy").sort((a, b) => (a.pricePerTonne > b.pricePerTonne ? -1 : 1))[0];
// 價格優先：出價比做市帳戶高的買單（模擬人物的）會先成交，所以數量要把它們也吃完，剩下的 2 噸才輪到做市帳戶
const ahead = [...s.book.values()].filter((o) => o.side === "buy" && low(o.account) !== MM && o.expiry > t && o.pricePerTonne >= bestMmBid.pricePerTonne && (!o.country || o.country === "TW"))
  .reduce((a, o) => a + o.remainingKg, 0n);
const sold = await agent.user(user, "place", { side: "sell", batchId: BigInt(batch), country: "", amountKg: ahead + 2000n, pricePerTonne: bestMmBid.pricePerTonne, minFillKg: 0n, expiry: t + 3600n });
if (!sold.fills.some((f) => low(f.buyer) === MM)) console.error(sold.rejectedReason, sold.fills);
assert.ok(sold.fills.some((f) => low(f.buyer) === MM), "賣給做市帳戶");
ok(`真實使用者以做市買價 ${Number(bestMmBid.pricePerTonne) / 1e6} 元／噸賣出，排在前面的買單吃完之後由做市帳戶接下 ${Number(sold.fills.filter((f) => low(f.buyer) === MM).reduce((a, f) => a + f.amountKg, 0n)) / 1000} 噸`);

// 下一輪做市有庫存了，應該掛出賣價
node("scripts/mm/mm.mjs", ["--once"]);
st = status();
assert.ok(st.inventoryKg >= 2000, "做市帳戶持有剛買進的額度");
assert.ok(st.quotes.asks.length > 0, "有庫存之後掛出賣價");
ok(`做市帳戶有 ${st.inventoryKg / 1000} 噸庫存，掛出 ${st.quotes.asks.length} 檔賣價`);

// ① 做市帳戶從來不是吃單方
s = agent.state();
const takerMm = s.fills.filter((f) => {
  const taker = store.read(f.takerSeq, f.takerSeq)[0];
  return taker && low(taker.account) === MM;
});
assert.equal(takerMm.length, 0, "做市帳戶不能是吃單方");
ok(`做市帳戶參與的 ${s.fills.filter((f) => low(f.buyer) === MM || low(f.seller) === MM).length} 筆成交，吃單方全部是別人`);

// ── 收回資金 ──
mmConfig({ ...cfg, commands: { recall: 1, resume: 0 } });
node("scripts/mm/mm.mjs", ["--once"]);
st = status();
s = agent.state();
assert.ok(st.halted, "收回之後停止報價");
assert.equal([...s.book.values()].filter((o) => low(o.account) === MM).length, 0, "做市帳戶的單全部撤掉");
ok("收回資金：撤掉全部報價並停止（帳本裡的現金留在帳本合約，要憑證據提領）");

// ── 承諾與查核 ──
node("scripts/ledger-commit.mjs");
const v = node("scripts/ledger-commit.mjs", ["--verify"]);
assert.match(v, /查核完成/);
ok("承諾上鏈；查核者離線重驗每一筆簽章（做市、模擬人物、使用者），anchor 全部相符");

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n做市與模擬器 × 帳本端到端：${passed} 項全部通過`);
