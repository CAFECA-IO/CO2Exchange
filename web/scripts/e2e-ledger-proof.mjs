#!/usr/bin/env node
// 證據與發布 × 帳本合約的端到端測試（本機 anvil，設計 v4 第 6 期）。
//
//   anvil --port 38549 &
//   npm run test:ledger-proof
//
// 走一遍：部署 → 回填展示資料 → 一位使用者簽提領請求 → 承諾上鏈 →
//   ① 他的證明檔用獨立的驗證 CLI（scripts/verify-proof.mjs，只用 viem）對鏈上驗過；竄改一個數字就驗不過
//   ② 憑證明檔裡的參數從帳本合約領回（一般提領只放已請求的部分；同一份證據領不了第二次）
//   ③ 公開檔：不用帳本程式碼，只用檔案裡的雜湊重建 logRoot 與 registryRoot，等於鏈上的承諾
//   ④ 監理鏡像：匯出的完整帳本由查核工具重播，anchor 全部相符
//   ⑤ 逃生門：72 小時沒有新承諾之後，同一個人領回全部欠款（不只是請求的部分）
import assert from "node:assert/strict";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, http, keccak256, parseAbi, toHex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const { openStore } = await import("../lib/ledger/store.ts");
const { createAgent } = await import("../lib/ledger/agent.ts");
const { readCommitments, PROOF_ABI } = await import("../lib/ledger/chain.ts");
const { snapshotAt, userProofFile, balanceProofArgs } = await import("../lib/ledger/proofs.ts");

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:38549";
const ROOT = path.resolve(process.cwd(), "..");
const pub0 = createPublicClient({ transport: http(RPC) });
const chainId = await pub0.getChainId().catch(() => { console.error(`連不上 ${RPC}（先開 anvil --port 38549）`); process.exit(1); });
if (chainId !== 31337) { console.error("只在本機 anvil（31337）上跑"); process.exit(1); }
const chain = defineChain({ id: chainId, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 50 });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "co2x-proof-"));
const DEP = path.join(TMP, "deploy.json");
const DATA = path.join(TMP, "data");
const A0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

// ── 部署（不蓋掉開發用的部署檔）──
const depFile = path.join(ROOT, "deployments", "31337.json");
const backup = fs.existsSync(depFile) ? fs.readFileSync(depFile) : null;
execSync(`forge script script/DeployLedger.s.sol --rpc-url ${RPC} --broadcast`, {
  cwd: ROOT, stdio: "pipe", env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}`, SOVEREIGN_SIGNER: A0, OPERATOR_SIGNER: A0 },
});
fs.copyFileSync(depFile, DEP);
if (backup) fs.writeFileSync(depFile, backup);
const D = JSON.parse(fs.readFileSync(DEP, "utf8"));
const env = { ...process.env, RPC_URL: RPC, DEPLOYMENT_FILE: DEP, DATA_DIR: DATA, CHAIN_ID: "31337", ENV_FILE: path.join(TMP, "none.env") };
const node = (script, args = [], extraEnv = {}) => execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const store = openStore(path.join(DATA, "ledger"));
const receiptSigner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const agent = createAgent({ store, client: pub, domains: { chainId, ledger: D.ledger }, receiptSigner });
const commits = () => readCommitments(pub, D.ledger, { fromBlock: BigInt(D.deployedAtBlock ?? 0) });
const low = (a) => a.toLowerCase();
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };
console.log(`  部署 Ledger ${D.ledger}（一般提領已開啟：${await pub.readContract({ address: D.ledger, abi: PROOF_ABI, functionName: "withdrawalsEnabled" })}）`);

// ── 展示資料與第一期 ──
node("scripts/ledger-seed.mjs", ["--days", "6", "--users", "10"]);
node("scripts/ledger-commit.mjs");

// 一位有現金的模擬人物（金鑰由 anvil 的助記詞推出，只在本機）
const roster = JSON.parse(fs.readFileSync(path.join(DATA, "sim-personas.json"), "utf8")).personas;
let s = agent.state();
const who = roster.map((p) => ({ ...p, account: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: p.walletIndex }) }))
  .find((p) => (s.cash.get(low(p.address)) ?? 0n) > 10_000_000_000n);
assert.ok(who, "找得到一位有現金的人物");
const cash0 = s.cash.get(low(who.address));
const ask = cash0 / 4n;
const r = await agent.user(who.account, "withdraw", { amount: ask });
assert.ok(r && !r.rejectedReason);
s = agent.state();
assert.equal(s.pendingWithdraw.get(low(who.address)), ask);
ok(`${who.name} 簽提領請求 ${Number(ask) / 1e6} 元：可動用 → 待提領`);
node("scripts/ledger-commit.mjs");

// ── ① 證明檔 × 獨立驗證 ──
let cs = await commits();
let snap = snapshotAt(store.read(), cs.at(-1));
const file = userProofFile({ chainId, ledger: D.ledger, settlementToken: D.settlementToken, account: who.address, commitments: cs, events: store.read(), snap });
const proofPath = path.join(TMP, "proof.json");
fs.writeFileSync(proofPath, JSON.stringify(file, null, 2));
const reportPath = path.join(TMP, "report.json");
const v1 = spawnSync(process.execPath, ["scripts/verify-proof.mjs", proofPath, "--rpc", RPC, "--out", reportPath], { encoding: "utf8" });
assert.equal(v1.status, 0, v1.stdout + v1.stderr);
const kinds = [...new Set(file.proofs.map((p) => p.type))];
assert.deepEqual(kinds.sort(), ["credit", "custody", "event", "identity"].filter((k) => kinds.includes(k)).sort());
ok(`證明檔 ${file.proofs.length} 項（${kinds.join("、")}）以獨立 CLI 對鏈上驗過`);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
assert.equal(report.result, "match");
assert.ok(!JSON.stringify(report).includes(who.name), "報告不含證明檔的內容");
ok("驗證報告只有雜湊與鏈上原始資料（區塊、log），不含證明檔內容");

const tampered = JSON.parse(JSON.stringify(file));
tampered.proofs.find((p) => p.type === "custody").leaf.cash = String(BigInt(tampered.proofs.find((p) => p.type === "custody").leaf.cash) + 1n);
fs.writeFileSync(path.join(TMP, "bad.json"), JSON.stringify(tampered));
const v2 = spawnSync(process.execPath, ["scripts/verify-proof.mjs", path.join(TMP, "bad.json"), "--rpc", RPC], { encoding: "utf8" });
assert.equal(v2.status, 1);
ok("把持有金額改掉一個最小單位，驗證就不過");

// ── ② 憑證據領回 ──
await pub.request({ method: "anvil_setBalance", params: [who.address, toHex(10n ** 19n)] });
const w = createWalletClient({ account: who.account, chain, transport: http(RPC) });
const args = balanceProofArgs(snap, who.address);
assert.equal(args.leafRequested, ask);
const before = await pub.readContract({ address: D.settlementToken, abi: erc20, functionName: "balanceOf", args: [who.address] });
const tooMuch = await pub.simulateContract({ address: D.ledger, abi: PROOF_ABI, functionName: "withdrawCash", args: [ask + 1n, args], account: who.account }).then(() => null, (e) => e);
assert.ok(tooMuch, "超過請求的部分領不到");
await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: D.ledger, abi: PROOF_ABI, functionName: "withdrawCash", args: [ask, args] }) });
const after = await pub.readContract({ address: D.settlementToken, abi: erc20, functionName: "balanceOf", args: [who.address] });
assert.equal(after - before, ask);
const again = await pub.simulateContract({ address: D.ledger, abi: PROOF_ABI, functionName: "withdrawCash", args: [1n, args], account: who.account }).then(() => null, (e) => e);
assert.ok(again, "同一份證據領不了第二次");
ok(`一般提領：只放已請求的 ${Number(ask) / 1e6} 元（多 1 就被拒），同一份證據領不了第二次`);
await agent.mirror(D.ledger);
s = agent.state();
assert.equal(s.pendingWithdraw.get(low(who.address)) ?? 0n, 0n);
assert.equal(s.withdrawSettled.get(low(who.address)), ask);
ok("鏈上的 CashWithdrawn 鏡像進帳本：待提領銷帳、已領累計 = 請求累計");
node("scripts/ledger-commit.mjs");

// ── ③ 公開檔：只用檔案裡的雜湊重建 root ──
node("scripts/ledger-publish.mjs", ["--mirror", path.join(TMP, "mirror")]);
cs = await commits();
const inc = {
  leaf: (h) => keccak256(encodeAbiParameters([{ type: "bytes1" }, { type: "bytes32" }], ["0x00", h])),
  node: (l, rr) => keccak256(encodeAbiParameters([{ type: "bytes1" }, { type: "bytes32" }, { type: "bytes32" }], ["0x01", l, rr])),
};
const rootOf = (leaves) => { let cur = leaves.map(inc.leaf); while (cur.length > 1) { const n = []; for (let i = 0; i < cur.length; i += 2) n.push(i + 1 < cur.length ? inc.node(cur[i], cur[i + 1]) : cur[i]); cur = n; } return cur[0]; };
for (const c of cs) {
  const f = JSON.parse(fs.readFileSync(path.join(DATA, "public", "epochs", `${c.epoch}.json`), "utf8"));
  assert.equal(rootOf(f.leaves.map((x) => x.hash)), c.logRoot, `第 ${c.epoch} 期 logRoot`);
  assert.equal(rootOf(f.registry.leaves.map((x) => x.contentHash)), c.registryRoot, `第 ${c.epoch} 期 registryRoot`);
  assert.equal(f.manifest.anchor, c.anchor);
  assert.ok(!f.publicEvents.some((e) => ["place", "cancel", "identity", "cashDeposit", "cashWithdraw", "withdraw"].includes(e.kind)), "私密事件不公開全文");
}
ok(`公開檔 ${cs.length} 期：只用檔案裡的雜湊就重建出鏈上的 logRoot 與 registryRoot；委託單、身分、存提只公開雜湊`);

// ── ④ 監理鏡像 ──
const mv = node("scripts/ledger-commit.mjs", ["--verify"], { LEDGER_DIR: path.join(TMP, "mirror", "ledger"), DEPLOYMENT_FILE: path.join(TMP, "mirror", "deployment.json") });
assert.match(mv, /查核完成/);
const manifest = JSON.parse(fs.readFileSync(path.join(TMP, "mirror", "MANIFEST.json"), "utf8"));
assert.ok(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
ok("監理鏡像（完整帳本＋部署檔＋SHA-256 清單）由查核工具獨立重播，anchor 全部相符");

// ── ⑤ 逃生門 ──
cs = await commits();
snap = snapshotAt(store.read(), cs.at(-1));
const leaf = balanceProofArgs(snap, who.address);
await pub.request({ method: "evm_increaseTime", params: [72 * 3600 + 60] });
await pub.request({ method: "evm_mine", params: [] });
assert.equal(await pub.readContract({ address: D.ledger, abi: PROOF_ABI, functionName: "escapeActive" }), true);
const owed = leaf.leafCash + leaf.leafSettled - (await pub.readContract({ address: D.ledger, abi: PROOF_ABI, functionName: "withdrawnTotal", args: [who.address] }));
const b2 = await pub.readContract({ address: D.settlementToken, abi: erc20, functionName: "balanceOf", args: [who.address] });
await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: D.ledger, abi: PROOF_ABI, functionName: "withdrawCash", args: [owed, leaf] }) });
const b3 = await pub.readContract({ address: D.settlementToken, abi: erc20, functionName: "balanceOf", args: [who.address] });
assert.equal(b3 - b2, owed);
assert.equal(owed, leaf.leafCash, "逃生領回的是全部欠款");
ok(`逃生門：72 小時沒有新承諾，憑最後一期的證據領回全部欠款 ${Number(owed) / 1e6} 元（不只是請求的部分）`);
await agent.mirror(D.ledger);
s = agent.state();
assert.equal(s.cash.get(low(who.address)) ?? 0n, 0n);
ok("逃生提領鏡像進帳本：超出待提領的部分從可動用現金扣，帳本對得上");

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n證據與發布 × 帳本端到端：${passed} 項全部通過`);
