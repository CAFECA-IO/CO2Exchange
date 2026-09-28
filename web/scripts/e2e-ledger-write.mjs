#!/usr/bin/env node
// 帳本 v2 寫入面的端到端測試（設計 v4 第 3 期）：網站 API → 帳本 → 承諾上鏈 → 查核重播。
//
// 前置：
//   anvil --port 38547 &
//   SOVEREIGN_SIGNER=<anvil0> OPERATOR_SIGNER=<anvil0> forge script script/DeployLedger.s.sol --rpc-url http://127.0.0.1:38547 --broadcast
//   （部署檔另存一份，DEPLOYMENT_FILE 指向它）
//   DEPLOYMENT_FILE=… RPC_URL=… CHAIN_ID=31337 DATA_DIR=… npx next dev -p 10098
//   （帳本要是空的：創世狀態已有臺灣轄區、政策與預設費率；展示資料的掛單會讓成交數字對不上）
//
// 執行：BASE_URL=http://127.0.0.1:10098 node --experimental-strip-types scripts/e2e-ledger-write.mjs
//
// 全程用開發用登入：帳戶由代號推出私鑰，伺服器代簽的是真的簽章——最後的 ledger:verify
// 在收單區塊重驗每一筆，驗不過就是這一期寫入面有問題。
import { execSync } from "node:child_process";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:10098";
const RUN = Date.now().toString(36);
let passed = 0;
const ok = (cond, what) => { if (!cond) throw new Error(`✗ ${what}`); passed += 1; console.log(`  ✓ ${what}`); };

/// 開發用登入：NextAuth 的 credentials 流程（csrf → callback），自己管 cookie。
async function login(label) {
  const jar = new Map();
  const keep = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const c = await fetch(`${BASE}/api/auth/csrf`); keep(c);
  const { csrfToken } = await c.json();
  const r = await fetch(`${BASE}/api/auth/callback/dev`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() },
    body: new URLSearchParams({ csrfToken, address: label, json: "true" }),
  });
  keep(r);
  const api = async (path, init = {}) => {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}), cookie: cookie() } });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) { const e = new Error(`${path}: ${j.error?.code ?? res.status} ${j.error?.message ?? ""}`); e.code = j.error?.code; throw e; }
    return j.data;
  };
  const me = await api("/api/me");
  if (!me.address) throw new Error(`登入 ${label} 失敗`);
  return {
    label, address: me.address, api,
    post: (path, body) => api(path, { method: "POST", body: JSON.stringify(body) }),
    /// prepare → （伺服器代簽）submit
    async act(kind, fields) {
      const p = await this.post("/api/ledger", { op: "prepare", kind, fields });
      if (!p.devSigning) throw new Error("開發帳戶應該由伺服器代簽");
      return this.post("/api/ledger", { op: "submit", kind, fields: p.message, nonce: p.nonce });
    },
  };
}

console.log(`帳本寫入面端到端（${BASE}）`);
const admin = await login("admin@example.com");
const verifier = await login("verifier@example.com");
const corp = await login(`e2e-corp-${RUN}`);
const buyer = await login(`e2e-buyer-${RUN}`);
const indiv = await login(`e2e-indiv-${RUN}`);
ok(admin.address !== corp.address && corp.address !== buyer.address, "四個開發帳戶登入，各有自己的地址");

// ── 身分：申請 → 管理員核准 → 帳本裡的 identity 事件 ──
for (const [u, tier, id] of [[corp, 2, "12345678"], [buyer, 2, "87654321"], [indiv, 1, "A123456789"]]) {
  const r = await u.post("/api/kyc", { account: u.address, tier, idNumber: id, name: u.label });
  if (r.status === "pending") await admin.post("/api/kyc/decide", { id: r.id, approve: true });
  const k = await u.api(`/api/kyc?account=${u.address}`);
  ok(k.tier === tier && !k.frozen, `${u.label.split("-")[1]} 身分寫進帳本（tier ${tier}）`);
}

// ── 入金：鏈上存進帳本合約 → 鏡像進帳本 ──
for (const u of [buyer, indiv]) {
  await u.post("/api/ledger", { op: "devDeposit", amount: String(500_000n * 1_000_000n) });
  const me = await u.api("/api/ledger");
  ok(BigInt(me.cash.available) >= 500_000n * 1_000_000n, `${u.label.split("-")[1]} 存入 50 萬結算幣，帳本記到了`);
}
{
  const n = await admin.post("/api/ledger", { op: "sync" });
  ok(n.mirrored === 0, "重複同步不會重複入帳（鏈上存入只鏡像一次）");
}

// ── 專案：法人簽 RegisterProject；自然人被引擎擋下 ──
{
  const r = await corp.act("project", { name: `E2E 太陽能 ${RUN}`, methodology: "AMS-I.D.", location: "Tainan, TW", metadataURI: "" });
  ok(r.accepted, "法人登錄專案");
  const bad = await indiv.act("project", { name: "不該成功", methodology: "X", location: "TW", metadataURI: "" });
  ok(!bad.accepted && /法人/.test(bad.rejectedReason), `自然人登錄專案被帳本規則拒絕（${bad.rejectedReason}）`);
}
const projects = (await corp.api(`/api/projects?owner=${corp.address}`)).projects;
ok(projects.length === 1, "專案清單讀自帳本");
const projectId = projects[0].projectId;

// ── 核發：申請（附報告）→ 查驗機構核准 → issue 事件 ──
let batchId;
{
  const fd = new FormData();
  fd.set("projectId", String(projectId)); fd.set("owner", corp.address);
  fd.set("monitoringStart", "2025-01-01"); fd.set("monitoringEnd", "2025-12-31"); fd.set("amountTonnes", "120"); fd.set("note", "e2e");
  fd.set("report", new Blob([`%PDF-1.4 e2e report ${RUN}`], { type: "application/pdf" }), "report.pdf");
  const req = await corp.api("/api/issuance", { method: "POST", body: fd });
  const r = await verifier.post(`/api/issuance/${req.id}`, { approve: true });
  batchId = r.batchId;
  ok(r.status === "issued" && batchId > 0, `查驗機構核發 120 噸 → 批次 #${batchId}`);
  const me = await corp.api("/api/ledger");
  ok(me.credits.some((c) => c.batchId === String(batchId) && c.kg === "120000"), "額度記在專案方名下（帳本，不是 1155）");
}

// ── 交易：賣單 → 交叉的買單當場成交；撤單退回鎖定 ──
{
  const s = await corp.act("place", { side: "sell", batchId, amountKg: 50_000, pricePerTonne: 900_000_000, minFillKg: 0 });
  ok(s.accepted && s.receipt?.signature, "法人掛賣單 50 噸 @ 900，拿到簽收收據");
  const b = await buyer.act("place", { side: "buy", batchId: 0, country: "TW", amountKg: 30_000, pricePerTonne: 950_000_000, minFillKg: 0 });
  const filled = b.fills.reduce((x, f) => x + Number(f.amountKg), 0);
  ok(b.accepted && filled === 30_000, "買方出價 950 買 30 噸，當場以 900 成交");
  ok(b.fills.every((f) => f.pricePerTonne === "900000000"), "成交價是先掛的那一方（maker）的價格");
  const r2 = await indiv.act("place", { side: "buy", batchId: 0, country: "TW", amountKg: 10_000, pricePerTonne: 800_000_000, minFillKg: 0 });
  ok(r2.accepted && r2.fills.length === 0, "自然人出價 800 買 10 噸（沒交叉，掛在簿子上）");
  const before = await indiv.api("/api/ledger");
  ok(BigInt(before.cash.locked) === 8_000n * 1_000_000n, "買單鎖住 8,000 元");
  const c = await indiv.act("cancel", { orderSeq: r2.event.seq });
  ok(c.accepted, "撤單");
  const after = await indiv.api("/api/ledger");
  ok(after.cash.locked === "0" && after.orders.length === 0, "撤單之後鎖定歸零、簿子上沒有他的單");
  const bad = await buyer.act("cancel", { orderSeq: s.event.seq });
  ok(!bad.accepted, `撤別人的單被拒絕（${bad.rejectedReason}）`);

  // ── 費思的代操（第 5 期）：確認卡的數字從帳本算，要簽的是一筆帳本委託 ──
  const buy = await buyer.post("/api/faith/act", { kind: "buy_listing", params: { orderId: Number(s.event.seq), tonnes: 5 } });
  ok(buy.ledger?.kind === "place" && buy.ledger.fields.side === "buy" && buy.ledger.fields.pricePerTonne === "900000000" && !buy.calls,
    "費思的「買這張單」產生一筆同價買單（帳本委託，不是鏈上 calldata）");
  ok(buy.rows.some((r) => r.value === "4,500 mTWD"), "確認卡的金額從帳本算（5 噸 × 900 = 4,500）");
  const done = await buyer.act(buy.ledger.kind, buy.ledger.fields);
  ok(done.accepted && done.fills.reduce((x, f) => x + Number(f.amountKg), 0) === 5000, "簽了之後當場和那張賣單成交 5 噸");
  let code = null;
  try { await corp.post("/api/faith/act", { kind: "buy_listing", params: { orderId: Number(s.event.seq), tonnes: 1 } }); } catch (e) { code = e.code; }
  ok(code === "INVALID_PARAM", "費思不讓人買自己的賣單");
  const bid = await indiv.post("/api/faith/act", { kind: "place_bid", params: { tonnes: 2, pricePerTonne: 700 } });
  ok(bid.ledger?.fields.country === "TW" && bid.rows.some((r) => /鎖住/.test(r.label) && r.value === "1,400 mTWD"), "費思的掛買單：沒指定核發國就是國內，鎖定金額從帳本算");
  const placed = await indiv.act(bid.ledger.kind, bid.ledger.fields);
  const cx = await indiv.post("/api/faith/act", { kind: "cancel_bid", params: { bidId: Number(placed.event.seq) } });
  ok(cx.ledger?.kind === "cancel" && (await indiv.act(cx.ledger.kind, cx.ledger.fields)).accepted, "費思的撤單");
  const fau = await indiv.post("/api/faith/act", { kind: "claim_faucet", params: {} });
  ok(fau.deposit === String(100_000n * 1_000_000n), "費思的領水在帳本版會存進帳本合約");
}
{
  const m = await buyer.api(`/api/market?account=${buyer.address}`);
  ok(m.orders.some((o) => o.batchId === batchId && o.remainingKg === 15_000), "掛單簿讀自帳本：賣單剩 15 噸");
}

// ── 簽章：錯的 nonce、偽造的簽章都進不了帳本 ──
{
  const p = await buyer.post("/api/ledger", { op: "prepare", kind: "place", fields: { side: "buy", batchId: 0, country: "TW", amountKg: 1000, pricePerTonne: 1_000_000, minFillKg: 0 } });
  let code = null;
  try { await buyer.post("/api/ledger", { op: "submit", kind: "place", fields: p.message, nonce: p.nonce, signature: `0x${"11".repeat(65)}` }); } catch (e) { code = e.code; }
  ok(code === "SIGNATURE_INVALID", "偽造的簽章在收單時就被擋下（不寫進帳本）");
  code = null;
  try { await buyer.post("/api/ledger", { op: "submit", kind: "place", fields: p.message, nonce: "1" }); } catch (e) { code = e.code; }
  ok(code === "INVALID_PARAM", "用過的 nonce 被擋下");
}

// ── 註銷：法人簽 RetireCredits → 憑證（衍生資料）；自然人被擋 ──
{
  const r = await buyer.act("retire", { batchId, amountKg: 10_000, beneficiary: `E2E 公司 ${RUN}`, purpose: 1, memo: "e2e" });
  ok(r.accepted, "法人註銷 10 噸");
  const certs = (await buyer.api(`/api/certificates?account=${buyer.address}`)).certificates;
  ok(certs.length === 1 && certs[0].amountKg === 10_000 && certs[0].txHash.startsWith("0x"), "憑證讀自帳本（txHash 欄位是事件雜湊）");
  const certId = certs[0].certId;
  await admin.post(`/api/certificates/${certId}/pdf`, {});
  const a = await admin.post(`/api/certificates/${certId}/anchor`, {});
  ok(a.documentHash && a.txHash, "管理員產生 PDF 並把雜湊寫進帳本（certDocument）");
  let code = null;
  try { await admin.post(`/api/certificates/${certId}/anchor`, {}); } catch (e) { code = e.code; }
  ok(code === "ALREADY_EXISTS", "文件雜湊寫過就不能再寫");
  const all = (await admin.api("/api/certificates/all")).certificates;
  ok(all.find((c) => c.certId === certId)?.anchored === true, "管理員的憑證清單顯示已回寫");
}

// ── 費率：營運金鑰簽 fees 事件 ──
{
  await admin.post("/api/fees", { country: "TW", custom: true, tradeBps: 150, retireFeePerTonne: 30 });
  const f = await admin.api("/api/fees");
  const tw = f.rows.find((r) => r.country === "TW");
  ok(tw?.custom && tw.tradeBps === 150 && tw.retireFeePerTonne === "30000000", "臺灣費率寫進帳本");
  await admin.post("/api/fees", { country: "TW", custom: false, tradeBps: 0, retireFeePerTonne: 0 });
  const g = await admin.api("/api/fees");
  ok(!g.rows.find((r) => r.country === "TW").custom, "取消自訂 = 設回預設值");
}

// ── 主權事件 2-of-3：提案 → 兩位持有人簽署 → 寫進帳本（簽章模型方案 B）──
{
  const cli = (args, extra = {}) => execSync(`node --experimental-strip-types --no-warnings scripts/ledger-authority.mjs ${args}`, { env: { ...process.env, ...extra }, stdio: "pipe", encoding: "utf8" });
  const out = cli(`propose jurisdiction '${JSON.stringify({ country: "JP", enabled: true, domestic: false, purposeMask: 3, name: "日本", scheme: "J-Credit", registryName: "J-クレジット登録簿", note: "e2e" })}' --note e2e`);
  const id = out.match(/建立提案 ([0-9a-f]{16})/)[1];
  ok(/需要 2 個簽章/.test(out), "主權提案需要 2 個簽章");
  let refused = false;
  try { cli(`submit ${id}`); } catch { refused = true; }
  ok(refused, "簽章不夠時送不進帳本");
  // anvil 助記詞第 5、6 個帳戶＝本機部署的國家 Safe 持有人（公開的測試金鑰，只在本機鏈）
  cli(`sign ${id} --key-env E2E_OWNER_A`, { E2E_OWNER_A: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" });
  const g = await admin.api("/api/governance");
  ok(g.ledger.proposals.some((p) => p.id === id && p.collected === 1 && p.required === 2), "治理頁顯示提案進度 1/2");
  cli(`sign ${id} --key-env E2E_OWNER_B`, { E2E_OWNER_B: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e" });
  ok(/已寫進帳本/.test(cli(`submit ${id}`)), "兩位持有人簽署後寫進帳本");
  const f = await admin.api("/api/fees");
  ok(f.rows.some((r) => r.country === "JP" && r.enabled), "日本轄區生效（費率表出現 JP）");
}

// ── 治理頁：帳本合約＋授權金鑰清單 ──
{
  const g = await admin.api("/api/governance");
  ok(g.ledger && g.ledger.authorities.some((a) => a.role === "IDENTITY_VERIFIER"), "治理頁列出鏈上的授權金鑰清單");
  ok(g.ledger.thresholds.SOVEREIGN === 2, "治理頁顯示主權門檻 2");
}

// ── 承諾上鏈 → 查核者重播 ──
const env = { ...process.env };
const sh = (cmd) => execSync(cmd, { env, stdio: "pipe", encoding: "utf8" });
const commit = sh("node --experimental-strip-types --no-warnings scripts/ledger-commit.mjs");
ok(/已提交第 \d+ 期/.test(commit), "承諾上鏈");
const verify = sh("node --experimental-strip-types --no-warnings scripts/ledger-commit.mjs --verify");
ok(/查核完成/.test(verify), "查核者重播：收單區塊驗簽、存提逐筆、anchor 全部相符");

console.log(`\n帳本寫入面端到端：${passed} 項全部通過`);
