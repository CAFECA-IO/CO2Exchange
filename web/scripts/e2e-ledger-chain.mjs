#!/usr/bin/env node
// 帳本 v2 × 帳本合約的端到端測試（本機 anvil）。
//
//   anvil --port 38546 &
//   DEPLOYER_PK=… forge script script/DeployLedger.s.sol --rpc-url http://127.0.0.1:38546 --broadcast   （由本腳本代跑）
//   node --experimental-strip-types scripts/e2e-ledger-chain.mjs
//
// 走一遍真實的路：授權清單從合約事件讀、入金由營運 Safe 在鏈上確認、事件用那些授權金鑰簽、
// 重播**不讀任何歷史狀態**（不用 archive 節點）：授權事件 k-of-n ecrecover、CAFECA 帳戶的 WebAuthn 簽章以
// keyring 事件重建的公鑰驗；算出來的承諾送上鏈，
// 最後確認鏈上的 head 就是重播算出來的 anchor，並且由營運 Safe 憑證據確認一筆出金。
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
const { readAuthorities, readCommitments, readCashEvents, LEDGER_ABI, PROOF_ABI } = await import("../lib/ledger/chain.ts");
const { rootsOf } = await import("../lib/ledger/trees.ts");

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

// ── 入金：使用者匯新台幣到信託專戶 → 營運 Safe 在鏈上確認（鑄出只存在帳本合約裡的 TWD）──
const F = await import("../lib/ledger/fiat.ts");
const owners = F.localOperatorOwners();
const viaSafe = (call) => F.execOperatorSafe({ pub, sender: wallet(deployer), safe: D.operatorSafe, to: call.to, data: call.data, owners });
for (const [i, u] of [user1, user2].entries()) await viaSafe(F.creditDepositCall(D.ledger, u.address, 500_000_000_000n, F.bankRefOf("in", `e2e-chain-${i}`)));
const twd = parseAbi(["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
const cashToken = await pub.readContract({ address: D.ledger, abi: LEDGER_ABI, functionName: "cash" });
assert.equal(cashToken.toLowerCase(), D.settlementToken.toLowerCase(), "部署檔的 settlementToken 應該是帳本合約自己的 TWD");
assert.equal(await pub.readContract({ address: cashToken, abi: twd, functionName: "totalSupply" }), 1_000_000_000_000n);
assert.equal(await pub.readContract({ address: cashToken, abi: twd, functionName: "balanceOf", args: [D.ledger] }), 1_000_000_000_000n, "TWD 只在帳本合約裡");
const direct = await pub.simulateContract({ address: D.ledger, abi: LEDGER_ABI, functionName: "creditDeposit", args: [user1.address, 1n, F.bankRefOf("in", "direct")], account: deployer }).then(() => null, (e) => e);
assert.ok(direct, "部署者不能直接入金（只有營運 Safe）");
const dupe = await viaSafe(F.creditDepositCall(D.ledger, user1.address, 1n, F.bankRefOf("in", "e2e-chain-0"))).then(() => null, (e) => e);
assert.ok(dupe, "同一個銀行參考號不能入金兩次");
console.log("  入金：營運 Safe 確認兩筆，TWD 只在帳本合約裡；部署者直接入金、重複參考號都被拒絕");

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
const PAYOUT = F.payoutRefOf({ bankCode: "812", accountNo: "00012345678901", holder: "測試一" }, "e2e");
await user(user1, "withdraw", { amount: 100_000_000_000n, payoutRef: PAYOUT });
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

// ── 出金：請求已進承諾 → 營運方匯款 → 營運 Safe 憑證據確認（銷毀帳本裡的 TWD）──
const roots = rootsOf(again.state, 1n);
const bp = roots.balanceTree.proofOf(user1.address);
assert.equal(bp.leafRequested, 100_000_000_000n, "出金請求應在承諾的葉子裡");
const proof = { proofEpoch: 1n, assetsRoot: bp.assetsRoot, leafKg: bp.leafKg, leafCash: bp.leafCash, leafRequested: bp.leafRequested, leafSettled: bp.leafSettled, siblings: bp.siblings, path: bp.path };
const over = await viaSafe(F.settleWithdrawalCall(D.ledger, user1.address, 100_000_000_001n, F.bankRefOf("out", "e2e-over"), proof)).then(() => null, (e) => e);
assert.ok(over, "超過已承諾的出金請求應被拒絕");
await viaSafe(F.settleWithdrawalCall(D.ledger, user1.address, 100_000_000_000n, F.bankRefOf("out", "e2e-wire-1"), proof));
assert.equal(await pub.readContract({ address: cashToken, abi: twd, functionName: "totalSupply" }), 900_000_000_000n, "出金確認後 TWD 銷毀");
const cashEv = await readCashEvents(pub, D.ledger, range);
assert.equal(cashEv.filter((c) => c.kind === "cashDeposit").length, 2);
const w = cashEv.find((c) => c.kind === "cashWithdraw");
assert.equal(w?.bankRef, F.bankRefOf("out", "e2e-wire-1"), "出金事件帶銀行參考號的雜湊");
for (const c of cashEv.filter((c) => c.kind === "cashWithdraw")) events.push({ ...(await base()), ...c });
const after = await replay(events, { domains, authorities, keys: book, boundaries: committed });
assert.equal(after.state.pendingWithdraw.get(user1.address.toLowerCase()) ?? 0n, 0n, "鏈上確認後帳本的待出金歸零");
assert.equal(after.state.withdrawSettled.get(user1.address.toLowerCase()), 100_000_000_000n);
// 沒有逃生門：72 小時沒有新承諾，使用者也不能自己從合約領
await pub.request({ method: "evm_increaseTime", params: [72 * 3600 + 60] });
await pub.request({ method: "evm_mine", params: [] });
const self = await pub.simulateContract({ address: D.ledger, abi: PROOF_ABI, functionName: "settleWithdrawal", args: [user1.address, 1n, F.bankRefOf("out", "self"), proof], account: user1 }).then(() => null, (e) => e);
assert.ok(self, "使用者不能自己確認出金");
console.log("  出金：營運 Safe 憑第 1 期證據確認 100,000 元並銷毀 TWD；超額與使用者自行確認都被拒絕");
console.log("\n帳本 × 合約端到端：全部通過");
