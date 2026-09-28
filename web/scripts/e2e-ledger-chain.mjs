#!/usr/bin/env node
// 帳本 v2 × 帳本合約的端到端測試（本機 anvil）。
//
//   anvil --port 38546 &
//   DEPLOYER_PK=… forge script script/DeployLedger.s.sol --rpc-url http://127.0.0.1:38546 --broadcast   （由本腳本代跑）
//   node --experimental-strip-types scripts/e2e-ledger-chain.mjs
//
// 走一遍真實的路：授權清單從合約事件讀、結算幣真的存進合約、事件用那些授權金鑰簽、
// 重播**不讀任何歷史狀態**（不用 archive 節點）：授權事件 k-of-n ecrecover、CAFECA 帳戶的 WebAuthn 簽章以
// keyring 事件重建的公鑰驗；算出來的承諾送上鏈，
// 最後確認鏈上的 head 就是重播算出來的 anchor，並且用證據登記一筆碳權請求權。
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { authTypedData, userTypedData, userMessageOf } = await import("../lib/ledger/typed.ts");
const { replay } = await import("../lib/ledger/replay.ts");
const { loadKeyBook } = await import("../lib/ledger/keybook.ts");
const { encodeCafecaSignature, keyIdOf } = await import("../lib/ledger/signatures.ts");
const { newPasskey, webauthnSign } = await import("./lib/webauthn.mjs");
const { readAuthorities, readCommitments, readCashEvents, LEDGER_ABI } = await import("../lib/ledger/chain.ts");
const { rootsOf, TAG } = await import("../lib/ledger/trees.ts");

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:38546";
const ROOT = path.resolve(process.cwd(), "..");
// anvil 的預設帳戶——只在本機鏈上用
const PK = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
];
const [deployer, sov, idv, cv, user1, user2] = PK.map((k) => privateKeyToAccount(k));
// 國家 Safe 的另外兩位持有人（主權事件 2-of-3，簽章模型方案 B）
const natB = privateKeyToAccount(keccak256(toBytes("co2x-e2e-national-b"))), natC = privateKeyToAccount(keccak256(toBytes("co2x-e2e-national-c")));

const pub0 = createPublicClient({ transport: http(RPC) });
const chainId = await pub0.getChainId();
if (chainId !== 31337) { console.error("只在本機 anvil（31337）上跑"); process.exit(1); }
const chain = defineChain({ id: chainId, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 50 });
const wallet = (a) => createWalletClient({ account: a, chain, transport: http(RPC) });

// ── 部署 ──
const depFile = path.join(ROOT, "deployments", "31337.json");
const backup = fs.existsSync(depFile) ? fs.readFileSync(depFile) : null;
execSync(`forge script script/DeployLedger.s.sol --rpc-url ${RPC} --broadcast`, {
  cwd: ROOT, stdio: "pipe",
  env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}`, DEPLOYER_PK: PK[0],
    NATIONAL_OWNERS: [sov.address, natB.address, natC.address].join(","), NATIONAL_THRESHOLD: "2",
    IDENTITY_VERIFIER: idv.address, CARBON_VERIFIER: cv.address, COMMITTER: deployer.address },
});
const D = JSON.parse(fs.readFileSync(depFile, "utf8"));
if (backup) fs.writeFileSync(depFile, backup); // 不要蓋掉開發用的部署檔
console.log(`  部署 Ledger ${D.ledger}`);
const domains = { chainId, ledger: D.ledger };

// ── 入金（鏈上真的轉帳）──
const erc20 = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"]);
for (const u of [user1, user2]) {
  await pub.waitForTransactionReceipt({ hash: await wallet(deployer).writeContract({ address: D.settlementToken, abi: erc20, functionName: "mint", args: [u.address, 1_000_000_000_000n] }) });
  await pub.waitForTransactionReceipt({ hash: await wallet(u).writeContract({ address: D.settlementToken, abi: erc20, functionName: "approve", args: [D.ledger, 2n ** 255n] }) });
  await pub.waitForTransactionReceipt({ hash: await wallet(u).writeContract({ address: D.ledger, abi: LEDGER_ABI, functionName: "depositCash", args: [500_000_000_000n] }) });
}

// ── 帳本事件（收單當下的區塊高度 = 目前區塊）──
const events = [];
let seq = 0n;
const nonces = new Map();
const base = async () => ({ seq: ++seq, at: BigInt(Math.floor(Date.now() / 1000)) + seq, atBlock: await pub.getBlockNumber({ cacheTime: 0 }) });
async function auth(signer, kind, body) {
  const e = { ...(await base()), kind, ...body, signer: signer.address, signature: "0x" };
  e.signature = await signer.signTypedData(authTypedData(domains, e));
  events.push(e); return e;
}
/// k-of-n：同一則 LedgerEvent 由多位持有人各簽一次，簽章接在一起
async function authMulti(signers, kind, body) {
  const e = { ...(await base()), kind, ...body, signer: signers[0].address, signature: "0x" };
  const sigs = [];
  for (const a of signers) sigs.push(await a.signTypedData(authTypedData(domains, e)));
  e.signature = `0x${sigs.map((x) => x.slice(2)).join("")}`;
  events.push(e); return e;
}
async function user(a, kind, body) {
  const n = (nonces.get(a.address) ?? 0n) + 1n; nonces.set(a.address, n);
  const e = { ...(await base()), kind, account: a.address, nonce: n, ...body, signature: "0x" };
  e.signature = await a.signTypedData(userTypedData(domains, kind, userMessageOf(e)));
  events.push(e); return e;
}
const range = { fromBlock: BigInt(D.deployedAtBlock ?? 0) };
for (const c of await readCashEvents(pub, D.ledger, range)) events.push({ ...(await base()), ...c });

const lonePolicy = await auth(sov, "policy", { individualTransfer: false, individualRetire: true, treasury: deployer.address }); // 只有一位持有人：不夠門檻
await authMulti([sov, natB], "policy", { individualTransfer: true, individualRetire: false, treasury: deployer.address });
for (const u of [user1, user2]) await auth(idv, "identity", { account: u.address, tier: 2, expiry: 2_000_000_000n, jurisdiction: "TW", identityHash: keccak256(toBytes(u.address)), nonce: 0n, deadline: 2_000_000_000n });
await user(user1, "project", { name: "台中太陽能", methodology: "AMS-I.D", location: "台中", metadataURI: "" });
await auth(cv, "issue", { projectId: 1n, monitoringStart: 1_700_000_000n, monitoringEnd: 1_760_000_000n, amountKg: 30_000n, serialHash: keccak256(toBytes("s1")), reportHash: keccak256(toBytes("r1")), attestationId: 1n, deadline: 2_000_000_000n });
await user(user1, "place", { side: "sell", batchId: 1n, country: "", amountKg: 10_000n, pricePerTonne: 900_000_000n, minFillKg: 0n, expiry: 2_000_000_000n });
await user(user2, "place", { side: "buy", batchId: 0n, country: "TW", amountKg: 4_000n, pricePerTonne: 950_000_000n, minFillKg: 0n, expiry: 2_000_000_000n });
await auth(idv, "issue", { projectId: 1n, monitoringStart: 1n, monitoringEnd: 2n, amountKg: 1n, serialHash: keccak256(toBytes("fake")), reportHash: keccak256(toBytes("fake")), attestationId: 9n, deadline: 2_000_000_000n }); // 身分驗證服務不能核發

// ── CAFECA 帳戶：假的 keyring 與帳戶合約（只提供事件與介面），passkey 簽章由重播自己驗 ──
const art = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "out", "CafecaMocks.sol", `${name}.json`), "utf8"));
const deploy = async (name, args = []) => {
  const a = art(name);
  const hash = await wallet(deployer).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
};
const keyring = await deploy("MockKeyring");
const cafeca = await deploy("MockCafecaAccount", [keyring]);
const pk = newPasskey();
const keyId = keyIdOf(pk.qx, pk.qy);
const keyringAbi = art("MockKeyring").abi;
const addRc = await pub.waitForTransactionReceipt({ hash: await wallet(deployer).writeContract({ address: keyring, abi: keyringAbi, functionName: "addKey", args: [cafeca, pk.qx, pk.qy, pk.rpIdHash] }) });
const addLog = addRc.logs.find((l) => l.address.toLowerCase() === keyring.toLowerCase());
// 收單時伺服器會做的事：把公鑰鏡像進帳本（座標＋KeyAdded 的位置）
events.push({ ...(await base()), kind: "userKey", ref: { txHash: addRc.transactionHash, block: addRc.blockNumber, logIndex: addLog.logIndex },
  account: cafeca, keyId, qx: pk.qx, qy: pk.qy, rpIdHash: pk.rpIdHash, keyKind: 1, validator: keyring });
await auth(idv, "identity", { account: cafeca, tier: 2, expiry: 2_000_000_000n, jurisdiction: "TW", identityHash: keccak256(toBytes(cafeca)), nonce: 0n, deadline: 2_000_000_000n });
const { digestOf } = await import("../lib/ledger/typed.ts");
async function cafecaUser(kind, body) {
  const n = (nonces.get(cafeca) ?? 0n) + 1n; nonces.set(cafeca, n);
  const e = { ...(await base()), kind, account: cafeca, nonce: n, ...body, signature: "0x" };
  e.signature = encodeCafecaSignature({ validator: keyring, keyId, ...webauthnSign(pk, digestOf(domains, e)) });
  // 收單第一道：帳戶合約現在認不認（ERC-1271）
  const magic = await pub.readContract({ address: cafeca, abi: parseAbi(["function isValidSignature(bytes32,bytes) view returns (bytes4)"]), functionName: "isValidSignature", args: [digestOf(domains, e), e.signature] });
  events.push(e); return { e, magic };
}
const cafecaBid = await cafecaUser("place", { side: "buy", batchId: 0n, country: "TW", amountKg: 1_000n, pricePerTonne: 100_000_000n, minFillKg: 0n, expiry: 2_000_000_000n });
assert.equal(cafecaBid.magic, "0x1626ba7e", "帳戶合約應該認得這個簽章");
await pub.waitForTransactionReceipt({ hash: await wallet(deployer).writeContract({ address: keyring, abi: keyringAbi, functionName: "removeKey", args: [cafeca, keyId] }) });
const afterRemoval = await cafecaUser("cancel", { orderSeq: cafecaBid.e.seq });
assert.notEqual(afterRemoval.magic, "0x1626ba7e", "金鑰移除之後帳戶合約就不認了");

// ── 重播：授權清單與金鑰歷史都從鏈上**事件**讀，不讀任何歷史狀態 ──
const authorities = await readAuthorities(pub, D.ledger, range);
const { book, problems } = await loadKeyBook(pub, { keyring, events });
assert.deepEqual(problems, [], "金鑰鏡像應該都對得到鏈上的 KeyAdded");
const upTo = await pub.getBlockNumber({ cacheTime: 0 });
const r = await replay(events, { domains, authorities, keys: book, boundaries: [{ epoch: 1n, lastSeq: seq, upToBlock: upTo }] });
const e1 = r.epochs[0];
assert.equal(r.state.fills.length, 1, "應有一筆成交");
assert.ok(r.state.rejected.some((x) => x.kind === "issue"), "身分驗證服務的核發應被拒絕");
assert.match(r.sig.get(String(lonePolicy.seq)).reason, /需要 2 個簽章/, "主權事件只有一個簽章應被拒絕");
assert.equal(r.state.policy.individualTransfer, true, "兩位持有人簽的政策生效");
assert.equal(r.sig.get(String(cafecaBid.e.seq)).ok, true, "CAFECA passkey 簽章應以事件重建的公鑰驗過");
assert.match(r.sig.get(String(afterRemoval.e.seq)).reason, /不是有效狀態/, "金鑰移除之後簽的單應被拒絕");
console.log("  主權事件 2-of-3、CAFECA passkey 簽章（含金鑰移除）都以鏈上事件離線驗過");

// ── 提交承諾 ──
const input = { prev: e1.prev, epoch: e1.epoch, logRoot: e1.logRoot, ...e1.roots, upToBlock: e1.upToBlock, lastSeq: e1.lastSeq, rulesVersion: e1.rulesVersion };
const { balanceTree: _b, registry: _r, identity: _i, ...commitArgs } = input; void _b; void _r; void _i;
const onchainAnchor = await pub.readContract({ address: D.ledger, abi: LEDGER_ABI, functionName: "anchorOf", args: [commitArgs] });
assert.equal(onchainAnchor, e1.anchor, "合約算的 anchor 與重播不同");
await pub.waitForTransactionReceipt({ hash: await wallet(deployer).writeContract({ address: D.ledger, abi: LEDGER_ABI, functionName: "commit", args: [commitArgs] }) });
assert.equal(await pub.readContract({ address: D.ledger, abi: LEDGER_ABI, functionName: "head" }), e1.anchor);
const committed = await readCommitments(pub, D.ledger, range);
assert.equal(committed.length, 1); assert.equal(committed[0].anchor, e1.anchor);
console.log(`  第 1 期承諾上鏈：anchor ${e1.anchor.slice(0, 18)}…（${seq} 筆事件、成交 ${r.state.fills.length} 筆、拒絕 ${r.state.rejected.length} 筆）`);

// ── 重播者從鏈上重建：讀承諾邊界 → 重播 → anchor 一致 ──
const again = await replay(events, { domains, authorities: await readAuthorities(pub, D.ledger, range), keys: (await loadKeyBook(pub, { keyring, events })).book, boundaries: committed });
assert.equal(again.epochs[0].anchor, committed[0].anchor);
console.log("  重播者依鏈上邊界重算，anchor 一致");

// ── 逃生門：72 小時沒有新承諾 → 憑證據登記碳權請求權 ──
await pub.request({ method: "evm_increaseTime", params: [72 * 3600 + 60] });
await pub.request({ method: "evm_mine", params: [] });
const roots = rootsOf(again.state, 1n);
const bp = roots.balanceTree.proofOf(user2.address);
const ap = roots.balanceTree.assetProofOf(user2.address, 1n);
const rp = roots.registry.proofOf(TAG.batch, 1n);
const b = again.state.batches.get("1");
const claimAbi = parseAbi([
  "struct Node { bytes32 hash; uint256 kg; uint256 cash; }",
  "struct BalanceProof { uint64 proofEpoch; bytes32 assetsRoot; uint256 leafKg; uint256 leafCash; uint256 leafRequested; uint256 leafSettled; Node[] siblings; uint256 path; }",
  "struct BatchLeaf { uint256 id; uint256 projectId; uint64 monitoringStart; uint64 monitoringEnd; uint16 vintageYear; bytes32 serialHash; bytes32 reportHash; address verifier; uint64 issuedAt; uint256 issuedKg; uint256 retiredKg; bool frozen; }",
  "struct CreditProof { uint256 batchKg; bytes32[] assetSiblings; uint256 assetPath; BatchLeaf batch; bytes32[] registrySiblings; uint256 registryPath; }",
  "function claimCredits(uint256 amountKg, BalanceProof p, CreditProof cp)",
  "function claimedKg(address, uint64, uint256) view returns (uint256)",
]);
const balanceProof = { proofEpoch: 1n, assetsRoot: bp.assetsRoot, leafKg: bp.leafKg, leafCash: bp.leafCash, leafRequested: bp.leafRequested, leafSettled: bp.leafSettled, siblings: bp.siblings, path: bp.path };
const creditProof = {
  batchKg: ap.kg, assetSiblings: ap.siblings, assetPath: ap.path,
  batch: { id: b.id, projectId: b.projectId, monitoringStart: b.monitoringStart, monitoringEnd: b.monitoringEnd, vintageYear: b.vintageYear, serialHash: b.serialHash, reportHash: b.reportHash, verifier: b.verifier, issuedAt: b.issuedAt, issuedKg: b.issuedKg, retiredKg: b.retiredKg, frozen: b.frozen },
  registrySiblings: rp.siblings, registryPath: rp.path,
};
await pub.waitForTransactionReceipt({ hash: await wallet(user2).writeContract({ address: D.ledger, abi: claimAbi, functionName: "claimCredits", args: [ap.kg, balanceProof, creditProof] }) });
const claimed = await pub.readContract({ address: D.ledger, abi: claimAbi, functionName: "claimedKg", args: [user2.address, 1n, 1n] });
assert.equal(claimed, 4_000n);
console.log(`  逃生門：買方憑證據登記 ${claimed} kg 的碳權請求權`);
console.log("\n帳本 × 合約端到端：全部通過");
