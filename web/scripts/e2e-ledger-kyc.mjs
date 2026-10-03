#!/usr/bin/env node
// CAFECA 實名 × 帳本身分的端到端測試（本機 anvil）。
//
//   anvil --port 38552 &
//   npm run test:ledger-kyc
//
// 在本機鏈上部署一份**真的** CAFECA IdentityRegistry v2（test/vendor/cafeca，取自 CAFECA 原始碼），
// 用一把測試用的 KYC 簽章金鑰簽發實名，然後走一遍 CAFECA 那邊會發生的事，看 `npm run kyc:sync` 怎麼跟：
//   ① 有效 → 帳本身分維持
//   ② 暫停（例如身分恢復後待重驗）→ 帳本身分到期，存查紀錄記下原因；再跑一次不重複寫
//   ③ 重新簽發（nonce 變了）→ 恢復，效期跟著 CAFECA
//   ④ 撤銷 → 失效
//   ⑤ 重新簽發後簽章者被移除（CAFECA 換正式簽章者時，原型期的實名一律失效）→ 失效
//   ⑥ 人工審核的身分不受 CAFECA 影響
// 最後用查核工具重播：這些身分事件都是有效的授權事件。
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { openStore } = await import("../lib/ledger/store.ts");
const { createAgent } = await import("../lib/ledger/agent.ts");
const { readAuthorities } = await import("../lib/ledger/chain.ts");
const { isActive } = await import("../lib/ledger/engine.ts");

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:38552";
const ROOT = path.resolve(process.cwd(), "..");
const pub0 = createPublicClient({ transport: http(RPC) });
const chainId = await pub0.getChainId().catch(() => { console.error(`連不上 ${RPC}（先開 anvil --port 38552）`); process.exit(1); });
if (chainId !== 31337) { console.error("只在本機 anvil（31337）上跑"); process.exit(1); }
const chain = defineChain({ id: chainId, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 50 });
const PATH = `${process.env.HOME}/.foundry/bin:${process.env.PATH}`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "co2x-kyc-"));
const DEP = path.join(TMP, "deploy.json");
const DATA = path.join(TMP, "data");
fs.mkdirSync(DATA, { recursive: true });
const A0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PK0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

// ── 部署帳本與 IdentityRegistry v2 ──
const depFile = path.join(ROOT, "deployments", "31337.json");
const backup = fs.existsSync(depFile) ? fs.readFileSync(depFile) : null;
execSync(`forge script script/DeployLedger.s.sol --rpc-url ${RPC} --broadcast`, { cwd: ROOT, stdio: "pipe", env: { ...process.env, PATH, SOVEREIGN_SIGNER: A0, OPERATOR_SIGNER: A0 } });
fs.copyFileSync(depFile, DEP);
if (backup) fs.writeFileSync(depFile, backup); else fs.rmSync(depFile);
const D = JSON.parse(fs.readFileSync(DEP, "utf8"));
const created = execSync(`forge create test/vendor/cafeca/IdentityRegistry.sol:IdentityRegistry --rpc-url ${RPC} --private-key ${PK0} --broadcast --constructor-args ${A0}`,
  { cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH } });
const REG = /Deployed to: (0x[0-9a-fA-F]{40})/.exec(created)?.[1];
assert.ok(REG, "IdentityRegistry 部署成功");

const REG_ABI = parseAbi([
  "function setSigner(address signer, uint8 cls)",
  "function attest(address account, uint8 subjectType, uint8 level, uint48 expiry, bytes32 claimsRoot, bytes2 jurisdiction, uint64 nonce, bytes sig)",
  "function suspend(address account, uint8 reason, uint64 nonce, bytes sig)",
  "function revoke(address account, uint8 reason, uint64 nonce, bytes sig)",
  "function nonceOf(address) view returns (uint64)",
]);
const gov = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(PK0) });
const kycSigner = privateKeyToAccount(keccak256(toBytes("e2e-cafeca-kyc-signer")));
const domain = { name: "CAFECA IdentityRegistry", version: "2", chainId, verifyingContract: REG };
const send = async (functionName, args) => { const h = await gov.writeContract({ address: REG, abi: REG_ABI, functionName, args }); await pub.waitForTransactionReceipt({ hash: h }); };
const nextNonce = async (a) => (await pub.readContract({ address: REG, abi: REG_ABI, functionName: "nonceOf", args: [a] })) + 1n;
const now = async () => (await pub.getBlock()).timestamp;
async function attest(account, subjectType, years = 1n) {
  const nonce = await nextNonce(account);
  const expiry = (await now()) + 365n * 86400n * years;
  const claimsRoot = keccak256(toBytes(`claims-${account}-${nonce}`));
  const sig = await kycSigner.signTypedData({ domain, primaryType: "Attest", types: { Attest: [
    { name: "account", type: "address" }, { name: "subjectType", type: "uint8" }, { name: "level", type: "uint8" }, { name: "expiry", type: "uint48" },
    { name: "claimsRoot", type: "bytes32" }, { name: "jurisdiction", type: "bytes2" }, { name: "nonce", type: "uint64" },
  ] }, message: { account, subjectType, level: 2, expiry, claimsRoot, jurisdiction: "0x5457", nonce } });
  await send("attest", [account, subjectType, 2, expiry, claimsRoot, "0x5457", nonce, sig]);
  return { nonce, expiry };
}
async function status(fn, account, reason) {
  const nonce = await nextNonce(account);
  const sig = await kycSigner.signTypedData({ domain, primaryType: "StatusChange", types: { StatusChange: [
    { name: "account", type: "address" }, { name: "status", type: "uint8" }, { name: "reason", type: "uint8" }, { name: "nonce", type: "uint64" },
  ] }, message: { account, status: fn === "suspend" ? 2 : 3, reason, nonce } });
  await send(fn, [account, reason, nonce, sig]);
}
await send("setSigner", [kycSigner.address, 1]); // PROTOTYPE
console.log(`  部署 Ledger ${D.ledger}、IdentityRegistry v2 ${REG}`);

// ── 帳本：兩個以 CAFECA 實名登記的帳戶（自然人、法人），一個人工審核 ──
const store = openStore(path.join(DATA, "ledger"));
const receiptSigner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const range = { fromBlock: BigInt(D.deployedAtBlock ?? 0) };
const agent = createAgent({ store, client: pub, domains: { chainId, ledger: D.ledger }, receiptSigner, authorities: () => readAuthorities(pub, D.ledger, range) });
const idv = privateKeyToAccount(PK0); // DeployLedger 在本機把 IDENTITY_VERIFIER 授權給 anvil 第 0 個帳戶
const PERSON = privateKeyToAccount(keccak256(toBytes("person"))).address;
const COMPANY = privateKeyToAccount(keccak256(toBytes("company"))).address;
const MANUAL = privateKeyToAccount(keccak256(toBytes("manual"))).address;
const hashOf = (x) => keccak256(toBytes(x));
const p1 = await attest(PERSON, 0);
const c1 = await attest(COMPANY, 1);
const register = async (account, tier, identityHash, expiry) => {
  const t = BigInt(Math.floor(Date.now() / 1000));
  const r = await agent.authority(idv, "identity", { account, tier, expiry, jurisdiction: "TW", identityHash, nonce: agent.state().identities.get(account.toLowerCase())?.attNonce ?? 0n, deadline: t + 3600n });
  assert.equal(r.rejectedReason, null, r.rejectedReason ?? "");
};
await register(PERSON, 1, hashOf("pw-person"), p1.expiry);
await register(COMPANY, 2, hashOf("ubn-company"), c1.expiry);
await register(MANUAL, 2, hashOf("ubn-manual"), BigInt(Math.floor(Date.now() / 1000)) + 365n * 86400n);
const rec = (account, tier, identityHash, nonce, extra = {}) => ({
  id: account.slice(2, 10), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  account, tier, submittedBy: account, status: "approved", source: "cafeca", decidedBy: "cafeca", idNumberMasked: "CAFECA 實名", identityHash,
  cafeca: { subjectType: tier === 2 ? "entity" : "person", attestationNonce: String(nonce), signer: kycSigner.address, signerClass: "prototype", expiry: 0, jurisdiction: "TW", checkedAt: new Date().toISOString() },
  ...extra,
});
const FILE = path.join(DATA, "kyc-requests.json");
fs.writeFileSync(FILE, JSON.stringify([
  rec(PERSON, 1, hashOf("pw-person"), p1.nonce),
  rec(COMPANY, 2, hashOf("ubn-company"), c1.nonce),
  { ...rec(MANUAL, 2, hashOf("ubn-manual"), 0), source: "manual", cafeca: undefined, decidedBy: A0 },
], null, 2));

const env = { ...process.env, RPC_URL: RPC, DEPLOYMENT_FILE: DEP, DATA_DIR: DATA, CHAIN_ID: "31337", ENV_FILE: path.join(TMP, "none.env"), CAFECA_IDENTITY_REGISTRY: REG };
const sync = () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/kyc-sync.mjs"], { env, encoding: "utf8" });
  if (r.status !== 0) console.log(r.stdout, r.stderr);
  return { code: r.status, out: r.stdout };
};
const recOf = (a) => JSON.parse(fs.readFileSync(FILE, "utf8")).filter((r) => r.account === a).at(-1);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const active = (a) => isActive(agent.state(), a, nowSec());
const idEvents = () => store.read().filter((e) => e.kind === "identity").length;

// ① 有效
{
  const before = idEvents();
  const r = sync();
  assert.equal(r.code, 0); assert.match(r.out, /2 個帳戶/);
  assert.equal(idEvents(), before, "都有效：不寫新的身分事件");
  assert.ok(active(PERSON) && active(COMPANY));
  ok("CAFECA 實名有效：kyc:sync 不動帳本（人工審核的帳戶不在同步範圍）");
}
// ② 暫停
{
  await status("suspend", PERSON, 5);
  const r = sync();
  assert.match(r.out, /失效 1/);
  assert.equal(active(PERSON), false, "帳本身分已到期");
  assert.ok(active(COMPANY));
  const x = recOf(PERSON);
  assert.equal(x.status, "lapsed"); assert.match(x.reason, /暫停/);
  const n = idEvents();
  sync();
  assert.equal(idEvents(), n, "再跑一次不重複寫");
  ok("CAFECA 暫停實名（身分恢復後待重驗）：帳本身分到期，存查紀錄記下原因；再跑一次不重複寫");
}
// ③ 重新簽發
{
  const p2 = await attest(PERSON, 0, 2n);
  const r = sync();
  assert.match(r.out, /恢復 1/);
  assert.ok(active(PERSON));
  assert.equal(agent.state().identities.get(PERSON.toLowerCase()).expiry, p2.expiry, "效期跟著 CAFECA");
  assert.equal(recOf(PERSON).status, "approved"); assert.equal(recOf(PERSON).cafeca.attestationNonce, String(p2.nonce));
  ok("CAFECA 重新簽發（nonce 變了）：帳本身分恢復，效期跟著新的證明");
}
// ④ 撤銷
{
  await status("revoke", COMPANY, 3);
  const r = sync();
  assert.match(r.out, /失效 1/);
  assert.equal(active(COMPANY), false);
  assert.match(recOf(COMPANY).reason, /撤銷/);
  ok("CAFECA 撤銷法人實名（公司解散）：帳本的法人身分失效");
}
// ⑤ 簽章者退役
{
  await send("setSigner", [kycSigner.address, 0]);
  const r = sync();
  assert.match(r.out, /失效 1/);
  assert.equal(active(PERSON), false);
  assert.match(recOf(PERSON).reason, /失效|過期/);
  ok("簽章者被移除（CAFECA 換正式簽章者）：原型期的實名一律失效，帳本身分跟著失效");
}
// ⑥ 人工審核不受影響
assert.ok(active(MANUAL));
ok("人工審核的身分不受 CAFECA 狀態影響");

// ── 查核：這些身分事件都是有效的授權事件 ──
const { replay } = await import("../lib/ledger/replay.ts");
const auth = await readAuthorities(pub, D.ledger, range);
const v = await replay(store.read(), { domains: { chainId, ledger: D.ledger }, authorities: auth, boundaries: [] });
const bad = [...v.sig.values()].filter((s) => !s.ok);
assert.equal(bad.length, 0, bad[0]?.reason);
ok(`查核者重播：${idEvents()} 筆身分事件的簽章全部有效（IDENTITY_VERIFIER 授權）`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nCAFECA 實名 × 帳本端到端：${passed} 項全部通過`);
