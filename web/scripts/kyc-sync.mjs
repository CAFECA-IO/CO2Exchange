#!/usr/bin/env node
// CAFECA 實名 → 帳本身分的同步（每小時跑；demo-box 的 commit-loop 每一期都會呼叫）。
//
//   npm run kyc:sync              # 重查每一個以 CAFECA 實名登記的帳戶，失效的讓帳本身分到期
//   npm run kyc:sync -- --plan    # 只列出會做什麼，不寫帳本
//
// 為什麼要定期跑，不能只在登入時查：CAFECA 會在使用者沒有登入的時候暫停或撤銷實名
//（法人解散、代表人異動、證據異常、簽章者退役）。不同步的話，帳本會繼續把一個已經失效的身分當成有效。
//
// 判斷規則和網站登入時同一套（lib/ledger/cafeca-identity.ts 的 syncPlan）。身分事件由本站的
// IDENTITY_VERIFIER 金鑰簽（和網站同一把）。存查紀錄在 web/data/kyc-requests.json。
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, defineChain, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { KeyError, keyring, setting } from "./lib/keys.mjs";

const { openStore } = await import("../lib/ledger/store.ts");
const { createAgent } = await import("../lib/ledger/agent.ts");
const { readAuthorities } = await import("../lib/ledger/chain.ts");
const { readKycStatus, syncPlan } = await import("../lib/ledger/cafeca-identity.ts");
const { deploymentIndex } = await import("../lib/ledger/logindex.ts");

const PLAN = process.argv.includes("--plan");
const RPC = setting("RPC_URL") ?? "http://127.0.0.1:28545";
const pub0 = createPublicClient({ transport: http(RPC) });
const chainId = await pub0.getChainId().catch(() => { console.error(`連不上 ${RPC}`); process.exit(3); });
const LOCAL = chainId === 31337 || chainId === 1337;
const chain = defineChain({ id: chainId, name: "co2x", nativeCurrency: { name: "N", symbol: "N", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: LOCAL ? 50 : 1000 });
const D = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`), "utf8"));
const DATA = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
const FILE = path.join(DATA, "kyc-requests.json");
const low = (a) => String(a).toLowerCase();

let rows = [];
try { rows = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { /* 沒有檔案＝沒有人登記過 */ }
const cafecaRows = rows.filter((r) => r.source === "cafeca");
if (cafecaRows.length === 0) { console.log("沒有以 CAFECA 實名登記的帳戶"); process.exit(0); }

// ── IdentityRegistry v2 的位址：環境變數優先，否則讀 CAFECA 的設定檔 ──
async function registryAddress() {
  const env = setting("CAFECA_IDENTITY_REGISTRY");
  if (env && isAddress(env)) return { registry: env, rpc: setting("CAFECA_RPC_URL") };
  const wallet = (setting("CAFECA_WALLET") ?? "https://cafeca.io").replace(/\/+$/, "");
  const r = await fetch(`${wallet}/.well-known/cafeca-configuration`, { signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`讀不到 CAFECA 設定檔（HTTP ${r.status}）`);
  const c = await r.json();
  const a = c?.contracts?.identityRegistry;
  if (!isAddress(a ?? "")) throw new Error("CAFECA 設定檔沒有 contracts.identityRegistry；請設 CAFECA_IDENTITY_REGISTRY");
  // 身分與帳本同鏈時用本站的節點
  return { registry: a, rpc: Number(c?.chain?.id) === chainId ? undefined : c?.chain?.rpc };
}
let reg;
try { reg = await registryAddress(); } catch (e) { console.error(`✗ ${e.message}`); process.exit(3); }
const idClient = reg.rpc ? createPublicClient({ transport: http(reg.rpc) }) : pub;
const acceptPrototype = LOCAL || setting("CAFECA_ACCEPT_PROTOTYPE") === "1";

// ── 帳本與身分驗證服務金鑰 ──
let idv, receiptSigner;
try {
  const ring = keyring({ chainId, isLocal: LOCAL });
  idv = privateKeyToAccount(ring.require("IDENTITY_VERIFIER_PK").pk);
  receiptSigner = privateKeyToAccount(ring.require("RECEIPT_SIGNER_PK", "RELAYER_PK").pk);
} catch (e) {
  if (e instanceof KeyError) { console.error(`\n${e.message}`); process.exit(3); }
  throw e;
}
const IDX = deploymentIndex({ dataDir: DATA, chainId, ledger: D.ledger, deployedAt: D.deployedAt, local: LOCAL });
const store = openStore(process.env.LEDGER_DIR ?? path.join(DATA, "ledger"));
const range = { fromBlock: BigInt(D.deployedAtBlock ?? 0), index: IDX };
const agent = createAgent({
  store, client: pub, domains: { chainId, ledger: D.ledger }, receiptSigner,
  authorities: () => readAuthorities(pub, D.ledger, range), fromBlock: range.fromBlock, index: IDX,
});

// 每個帳戶最新的一筆 CAFECA 紀錄；最新的核准身分若來自人工審核就不動它
const accounts = [...new Set(cafecaRows.map((r) => low(r.account)))];
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const counts = {};
let changed = false;
for (const a of accounts) {
  const rec = cafecaRows.filter((r) => low(r.account) === a).at(-1);
  if (rec.status !== "approved" && rec.status !== "lapsed") continue;
  const latest = rows.filter((r) => low(r.account) === a && (r.status === "approved" || r.status === "lapsed")).at(-1);
  if (latest && latest.source !== "cafeca") continue;
  let kyc;
  try { kyc = await readKycStatus((q) => idClient.readContract(q), reg.registry, rec.account); }
  catch (e) { console.log(`  ! ${rec.account} 讀不到實名狀態：${e.message.split("\n")[0]}`); counts.error = (counts.error ?? 0) + 1; continue; }
  const id = agent.state().identities.get(a);
  const plan = syncPlan({
    rec: { tier: rec.tier, status: rec.status, identityHash: rec.identityHash, attestationNonce: rec.cafeca?.attestationNonce, reason: rec.reason },
    cur: id ? { tier: id.tier, identityHash: id.identityHash, expiry: id.expiry, jurisdiction: id.jurisdiction } : null,
    kyc, acceptPrototype, now: nowSec(),
  });
  // 已經失效、這次也沒有變化的：只計數，不再印
  const action = plan.action === "lapsed" && rec.status === "lapsed" ? "still" : plan.action;
  counts[action] = (counts[action] ?? 0) + 1;
  if (action !== "ok" && action !== "still") console.log(`  ${plan.action === "lapsed" ? "✗" : plan.action === "error" ? "!" : "↻"} ${rec.account} ${plan.action}：${plan.detail}`);
  if (PLAN) continue;
  if (plan.identity) {
    const t = nowSec();
    const r = await agent.authority(idv, "identity", {
      account: rec.account, tier: plan.identity.tier, expiry: plan.identity.expiry, jurisdiction: plan.identity.jurisdiction,
      identityHash: plan.identity.identityHash, nonce: id?.attNonce ?? 0n, deadline: t + 3600n,
    });
    if (r.rejectedReason) { console.log(`    帳本拒絕：${r.rejectedReason}`); continue; }
  }
  if (plan.record) {
    Object.assign(rec, {
      status: plan.record.status, reason: plan.record.reason, updatedAt: new Date().toISOString(),
      cafeca: { ...rec.cafeca, attestationNonce: plan.record.attestationNonce, signer: plan.record.signer, signerClass: plan.record.signerClass, expiry: plan.record.expiry, checkedAt: new Date().toISOString() },
    });
    changed = true;
  }
}
if (changed) {
  // 先寫暫存檔再改名：網站同時在寫也只會有一方的變更被覆蓋，不會留下半個檔案
  const tmp = `${FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, FILE);
}
const summary = Object.entries(counts).map(([k, v]) => `${{ ok: "有效", renewed: "延長", lapsed: "失效", still: "仍失效", restored: "恢復", error: "讀不到" }[k] ?? k} ${v}`).join("、");
console.log(`CAFECA 實名同步${PLAN ? "（試算）" : ""}：${accounts.length} 個帳戶，${summary || "沒有需要處理的"}`);
process.exit(counts.error ? 1 : 0);
