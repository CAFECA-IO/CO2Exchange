#!/usr/bin/env node
// 帳本 v2 的測試：事件 → 驗簽 → 引擎 → root → anchor。
//
//   cd web && npm run test:ledger
//
// 測的是「鏈上只放壓縮證據」這個設計能不能成立的那幾件事：
//   ① 規則照原本合約的語意執行（身分、轄區、用途、自然人政策、凍結）
//   ② 簽章與授權：不在授權清單、授權過期、簽章被換掉，一律拒絕
//   ③ 守恆：碳權 = 核發 − 註銷；現金 = 存入 − 提領（手續費進國庫，不憑空消失）
//   ④ 決定性：同一串事件跑兩次、打亂輸入順序，anchor 位元組等同
//   ⑤ 竄改：改任何一筆事件，那一期與之後的 anchor 全部改變
//   ⑥ 證據：登錄簿、身分、事件包含證據都算得回鏈上的 root
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { genesis, apply, balancesOf } = await import("../lib/ledger/engine.ts");
const { logTree, logLeaf, eventHash } = await import("../lib/ledger/events.ts");
const { authTypedData, userTypedData, userMessageOf } = await import("../lib/ledger/typed.ts");
const { replay, ecdsaVerifier } = await import("../lib/ledger/replay.ts");
const { rootsOf, TAG, batchContent } = await import("../lib/ledger/trees.ts");
const { rootFrom, leaf } = await import("../lib/ledger/merkle.ts");

const key = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const acct = (n) => privateKeyToAccount(key(n));
const S = acct(11), I = acct(12), C = acct(13), D = acct(14), A = acct(15), O = acct(16);
const X = acct(21), Y = acct(22), Z = acct(23), T = acct(24), EVIL = acct(99);
const domains = { chainId: 8018, ledger: "0x1111111111111111111111111111111111111111" };
const grant = (role, a, from = 0n, until = null) => ({ role, account: a.address, from, until });
const authorities = { grants: [
  grant("SOVEREIGN", S), grant("IDENTITY_VERIFIER", I), grant("CARBON_VERIFIER", C, 0n, 500n),
  grant("DOCUMENT_SIGNER", D), grant("AUDITOR", A), grant("OPERATOR", O),
] };

// ── 事件工廠 ──
let seq = 0n, clock = 1_800_000_000n, block = 100n;
const nonces = new Map();
const nextNonce = (a) => { const n = (nonces.get(a.address) ?? 0n) + 1n; nonces.set(a.address, n); return n; };
async function auth(signer, kind, body) {
  seq += 1n; clock += 60n; block += 1n;
  const e = { seq, at: clock, atBlock: block, kind, ...body, signer: signer.address, signature: "0x" };
  e.signature = await signer.signTypedData(authTypedData(domains, e));
  return e;
}
async function user(a, kind, body) {
  seq += 1n; clock += 60n; block += 1n;
  const e = { seq, at: clock, atBlock: block, kind, account: a.address, nonce: nextNonce(a), ...body, signature: "0x" };
  e.signature = await a.signTypedData(userTypedData(domains, kind, userMessageOf(e)));
  return e;
}
function chain(kind, account, amount) {
  seq += 1n; clock += 60n; block += 1n;
  return { seq, at: clock, atBlock: block, kind, account: account.address, amount, ref: { txHash: keccak256(toBytes(`tx${seq}`)), block, logIndex: 0 } };
}
const id = (a, tier, nonce = 0n) => auth(I, "identity", { account: a.address, tier, expiry: clock + 10_000_000n, jurisdiction: "TW", identityHash: keccak256(toBytes(`id:${a.address}`)), nonce, deadline: clock + 3600n });
const issue = (projectId, kg, n, signer = C) => auth(signer, "issue", { projectId, monitoringStart: 1_700_000_000n, monitoringEnd: 1_760_000_000n, amountKg: kg, serialHash: keccak256(toBytes(`serial${n}`)), reportHash: keccak256(toBytes(`report${n}`)), attestationId: BigInt(n), deadline: clock + 3600n });
const place = (a, side, batchId, country, kg, price, extra = {}) => user(a, "place", { side, batchId, country, amountKg: kg, pricePerTonne: price * 1_000_000n, minFillKg: 0n, expiry: clock + 86_400n, ...extra });

const P = (n) => n * 1_000_000n;
const events = [];
const push = async (p) => { const e = await p; events.push(e); return e; };

await push(auth(S, "policy", { individualTransfer: true, individualRetire: false, treasury: T.address }));
await push(auth(S, "jurisdiction", { country: "JP", enabled: true, domestic: false, purposeMask: 0x03, name: "日本", scheme: "J-Credit", registryName: "J-クレジット登録簿", note: "" }));
await push(id(X, 2)); await push(id(Y, 2)); await push(id(Z, 1));
await push(user(X, "project", { name: "高雄廢熱回收", methodology: "AMS-III.Q", location: "高雄", metadataURI: "ipfs://x" }));  // project 1
await push(issue(1n, 50_000n, 1));                                                                                          // batch 1（TW）
await push(auth(S, "importProject", { owner: O.address, country: "JP", scheme: "J-Credit", name: "北海道森林", methodology: "FO-001", location: "北海道", metadataURI: "" })); // project 2
await push(issue(2n, 20_000n, 2));                                                                                          // batch 2（JP）
await push(chain("cashDeposit", Y, P(1_000_000n)));
await push(chain("cashDeposit", Z, P(100_000n)));
const sell1 = await push(place(X, "sell", 1n, "", 10_000n, 800n));
await push(place(Y, "buy", 0n, "TW", 5_000n, 850n));          // 吃 5 噸 @ 800
await push(place(Z, "buy", 1n, "", 1_000n, 800n));            // 自然人買 1 噸
await push(auth(O, "fees", { country: "", tradeBps: 100n, retireFeePerTonne: P(10n) }));
await push(user(Z, "retire", { batchId: 1n, amountKg: 500n, beneficiary: "王小明", beneficiaryHash: keccak256(toBytes("z")), purpose: 1, memo: "" }));   // 拒絕：自然人不能註銷
await push(user(Y, "retire", { batchId: 1n, amountKg: 2_000n, beneficiary: "乙公司", beneficiaryHash: keccak256(toBytes("y")), purpose: 0, memo: "2026 碳費" })); // cert 1
await push(issue(1n, 1_000n, 3, EVIL));                                                                                     // 拒絕：不是查驗機構
await push(id(Y, 2, 0n));                                                                                                   // 拒絕：nonce 已用過
await push(place(Y, "sell", 2n, "", 1_000n, 500n));                                                                         // 拒絕：Y 沒有 JP 額度
await push(auth(D, "certDocument", { certId: 1n, documentHash: keccak256(toBytes("pdf")) }));
await push(auth(D, "certDocument", { certId: 1n, documentHash: keccak256(toBytes("pdf2")) }));                              // 拒絕：不能改
await push(auth(S, "freeze", { target: 0, account: X.address, batchId: 0n, frozen: true, reason: "調查中" }));             // X 剩下的賣單被撤
await push(place(X, "sell", 1n, "", 1_000n, 700n));                                                                         // 拒絕：凍結
const rep = await push(auth(D, "reserveReport", { period: 202609, asOf: clock, credits: [{ country: "TW", custodian: "環境部", accountRef: "TW-1", heldKg: 48_000n, ledgerKg: 48_000n, statementHash: keccak256(toBytes("s")) }], cash: { trustee: "某銀行", accountRef: "T-1", balance: P(1_100_000n), tokenSupply: P(1_100_000n), statementHash: keccak256(toBytes("c")) }, documentHash: keccak256(toBytes("r")) }));
await push(auth(A, "reserveAttest", { reportId: 1n, status: 1, auditorName: "某會計師事務所", note: "相符" }));
block = 600n;
await push(issue(1n, 1_000n, 4));                                                                                           // 拒絕：C 的授權到 500 為止
void rep; void sell1;

let n = 0;
const t = async (name, fn) => { await fn(); n += 1; console.log(`  ✓ ${name}`); };
const boundaries = [{ epoch: 1n, lastSeq: 12n, upToBlock: 112n }, { epoch: 2n, lastSeq: BigInt(events.length), upToBlock: 700n }];
const run = (evs = events) => replay(evs, { domains, authorities, verifier: ecdsaVerifier, boundaries });
const r = await run();
const s = r.state;
const reasons = Object.fromEntries(s.rejected.map((x) => [String(x.seq), x.reason]));
if (process.env.DEBUG) { for (const e of events) console.log(String(e.seq), e.kind, reasons[String(e.seq)] ?? ""); }

await t("撮合：買單以賣方掛價成交、手續費由賣方付", async () => {
  const f = s.fills.filter((x) => x.buyer === Y.address);
  assert.equal(f.length, 1); assert.equal(f[0].amountKg, 5_000n); assert.equal(f[0].pricePerTonne, P(800n));
  assert.equal(f[0].fee, (P(4_000n) * 100n) / 10_000n);
});
await t("自然人可以買、不能註銷（政策）", async () => {
  assert.ok(s.fills.some((x) => x.buyer === Z.address));
  assert.match(reasons["16"], /自然人不能註銷/);
});
await t("註銷產生憑證、扣批次、收註銷費", async () => {
  const c = s.certificates.get("1");
  assert.equal(c.amountKg, 2_000n); assert.equal(c.account, Y.address); assert.equal(c.fee, P(20n));
  assert.equal(s.batches.get("1").retiredKg, 2_000n);
});
await t("不在授權清單的核發被拒絕；授權過期後的核發被拒絕", async () => {
  assert.match(reasons["18"], /簽章或授權無效/);
  assert.match(reasons[String(events.length)], /簽章或授權無效/);
  assert.match(r.sig.get(String(events.length)).reason, /沒有 CARBON_VERIFIER 授權/);
});
await t("身分證明 nonce 重用被拒絕；沒有持有的批次不能賣", async () => {
  assert.match(reasons["19"], /nonce/); assert.match(reasons["20"], /碳權餘額不足/);
});
await t("憑證文件雜湊回寫後不能改", async () => { assert.match(reasons["22"], /不能更改/); });
await t("凍結帳戶：掛單被撤回、之後不能再掛", async () => {
  assert.ok(![...s.book.values()].some((o) => o.account === X.address));
  assert.match(reasons["24"], /凍結/);
});
await t("對帳報告與查核簽署", async () => { assert.equal(s.reports.get("1").status, 1); assert.equal(s.reports.get("1").auditor, A.address); });

await t("守恆：每一批的持有 = 核發 − 註銷；現金 = 存入（手續費在國庫）", async () => {
  const bal = balancesOf(s);
  for (const [bid, b] of s.batches) {
    const held = bal.reduce((sum, x) => sum + (x.assets.find((a) => String(a.batchId) === bid)?.kg ?? 0n), 0n);
    assert.equal(held, b.issuedKg - b.retiredKg, `批次 ${bid}`);
  }
  const cash = bal.reduce((sum, x) => sum + x.cash, 0n);
  assert.equal(cash, P(1_100_000n));
  assert.ok(bal.find((x) => x.account.toLowerCase() === T.address.toLowerCase()).cash > 0n);
});
await t("決定性：再跑一次、打亂輸入順序，anchor 位元組等同", async () => {
  const again = await run([...events].reverse());
  assert.deepEqual(again.epochs.map((e) => e.anchor), r.epochs.map((e) => e.anchor));
});
await t("anchor 串連：第 2 期的 prev 是第 1 期的 anchor", async () => {
  assert.equal(r.epochs[1].prev, r.epochs[0].anchor);
});
await t("竄改：改第 12 筆（賣單）的數量，第 1 期與第 2 期的 anchor 都變", async () => {
  const bad = events.map((e) => (e.seq === 12n ? { ...e, amountKg: 9_000n } : e));
  const x = await run(bad);
  assert.notEqual(x.epochs[0].anchor, r.epochs[0].anchor);
  assert.notEqual(x.epochs[1].anchor, r.epochs[1].anchor);
  // 而且那一筆因為簽章對不上而被拒絕——竄改內容等於偽造簽章
  assert.match(x.state.rejected.find((q) => q.seq === 12n).reason, /簽章/);
});
await t("竄改：拿掉一筆事件 → 帳本缺號，重播直接失敗", async () => {
  await assert.rejects(() => run(events.filter((e) => e.seq !== 5n)), /缺號/);
});
await t("證據：批次在 registryRoot、身分在 identityRoot、事件在 logRoot", async () => {
  const roots = rootsOf(s, 2n);
  const bp = roots.registry.proofOf(TAG.batch, 1n);
  assert.equal(bp.content, batchContent(s.batches.get("1")));
  assert.equal(rootFrom(leaf(bp.content), bp), roots.registryRoot);
  const ip = roots.identity.proofOf(Y.address);
  assert.equal(rootFrom(leaf(ip.content), ip), roots.identityRoot);
  const slice = events.filter((e) => e.seq > 12n);
  const lt = logTree(slice);
  const target = slice.find((e) => e.kind === "reserveReport");
  const lp = lt.proofOf(target.seq);
  assert.equal(rootFrom(logLeaf(target), lp), r.epochs[1].logRoot);
  assert.equal(r.epochs[1].logRoot, lt.root);
});
await t("買單分批成交：捨去的零頭全部退回，鎖定歸零", async () => {
  const st = genesis();
  const evs = [];
  seq = 0n;
  const W = acct(31), V = acct(32);
  const ids = [await id(W, 2), await id(V, 2)];
  // W 需要一個專案與額度
  const pr = await user(W, "project", { name: "p", methodology: "m", location: "l", metadataURI: "" });
  const is = await issue(1n, 10_000n, 77);
  const dep = chain("cashDeposit", V, P(10_000n));
  const buy = await user(V, "place", { side: "buy", batchId: 0n, country: "", amountKg: 3n, pricePerTonne: 500n, minFillKg: 0n, expiry: clock + 86_400n });
  const s1 = await user(W, "place", { side: "sell", batchId: 1n, country: "", amountKg: 1n, pricePerTonne: 500n, minFillKg: 0n, expiry: clock + 86_400n });
  const s2 = await user(W, "place", { side: "sell", batchId: 1n, country: "", amountKg: 1n, pricePerTonne: 500n, minFillKg: 0n, expiry: clock + 86_400n });
  const s3 = await user(W, "place", { side: "sell", batchId: 1n, country: "", amountKg: 1n, pricePerTonne: 500n, minFillKg: 0n, expiry: clock + 86_400n });
  evs.push(...ids, pr, is, dep, buy, s1, s2, s3);
  const sig = new Set((await Promise.all(evs.map(async (e) => e))).map((e) => String(e.seq)));
  apply(st, evs, { sigOk: (q) => sig.has(String(q)) });
  assert.equal(st.fills.length, 3);
  // 1 公斤 × 每噸 500 最小單位 = 0.5 → 捨去成 0；3 公斤鎖了 1。沒有逐筆記帳的話，這 1 會永遠卡在鎖定裡
  assert.equal(st.fills.reduce((x, f) => x + f.cost, 0n), 0n);
  assert.equal(st.lockedCash.get(V.address.toLowerCase()) ?? 0n, 0n);
  const total = (st.cash.get(V.address.toLowerCase()) ?? 0n) + (st.cash.get(W.address.toLowerCase()) ?? 0n) + st.treasuryCash;
  assert.equal(total, P(10_000n));
});

console.log(`\n${n} 個測試通過（事件 ${events.length} 筆，拒絕 ${s.rejected.length} 筆，成交 ${s.fills.length} 筆）`);
void eventHash;
