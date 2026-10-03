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
import { buildScenario } from "./lib/ledger-scenario.mjs";

const { genesis, apply, balancesOf } = await import("../lib/ledger/engine.ts");
const { logTree, logLeaf, eventHash } = await import("../lib/ledger/events.ts");
const { replay } = await import("../lib/ledger/replay.ts");
const { rootsOf, TAG, batchContent } = await import("../lib/ledger/trees.ts");
const { rootFrom, leaf } = await import("../lib/ledger/merkle.ts");

const { events, domains, authorities, actors, factory } = await buildScenario();
const { X, Y, Z, T, A, EVIL } = actors;
void Y;
const { user, chain, id, issue, acct, P } = factory;
let clock = factory.now();

let n = 0;
const t = async (name, fn) => { await fn(); n += 1; console.log(`  ✓ ${name}`); };
const boundaries = [{ epoch: 1n, lastSeq: 12n, upToBlock: 112n }, { epoch: 2n, lastSeq: BigInt(events.length), upToBlock: 700n }];
const run = (evs = events) => replay(evs, { domains, authorities, boundaries });
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
  factory.reset();
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


// ── 不需要歷史狀態的驗簽（簽章模型：不用 archive 節點；機構簽章方案 B） ──
{
  const { verifyAuthoritySignatures, verifyUserSignature, buildKeyBook, encodeCafecaSignature, keyIdOf } = await import("../lib/ledger/signatures.ts");
  const { verifySignatures } = await import("../lib/ledger/replay.ts");
  const { authTypedData, digestOf } = await import("../lib/ledger/typed.ts");
  const { newPasskey, webauthnSign } = await import("./lib/webauthn.mjs");
  const { hashTypedData, concat, keccak256: k256, toBytes: tb } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const s1 = privateKeyToAccount(k256(tb("sov-1"))), s2 = privateKeyToAccount(k256(tb("sov-2"))), s3 = privateKeyToAccount(k256(tb("sov-3")));
  const multi = {
    grants: [s1, s2, s3].map((a) => ({ role: "SOVEREIGN", account: a.address, from: 10n, until: a === s3 ? 50n : null })),
    thresholds: [{ role: "SOVEREIGN", value: 2, from: 10n }],
  };
  const draft = { seq: 1n, at: 1n, atBlock: 20n, kind: "policy", individualTransfer: true, individualRetire: false, treasury: s1.address, signer: s1.address, signature: "0x" };
  const digest = hashTypedData(authTypedData(domains, draft));
  const sig = async (a) => a.signTypedData(authTypedData(domains, draft));
  const check = (signature, over = {}) => verifyAuthoritySignatures({ role: "SOVEREIGN", signer: s1.address, digest, signature, atBlock: 20n, ...over }, multi);

  await t("k-of-n：主權門檻 2，只有一個簽章被拒絕、兩個不同持有人通過", async () => {
    assert.match((await check(await sig(s1))).reason, /需要 2 個簽章/);
    assert.equal((await check(concat([await sig(s1), await sig(s2)]))).ok, true);
  });
  await t("k-of-n：同一人簽兩次、signer 不在簽章者之中、撤銷後的金鑰，一律拒絕", async () => {
    assert.match((await check(concat([await sig(s1), await sig(s1)]))).reason, /重複/);
    assert.match((await check(concat([await sig(s2), await sig(s3)]))).reason, /signer 欄位不在簽章者之中/);
    assert.match((await check(concat([await sig(s1), await sig(s3)]), { atBlock: 60n })).reason, /沒有 SOVEREIGN 授權/);
    assert.equal((await check(concat([await sig(s1), await sig(s3)]), { atBlock: 40n })).ok, true);
  });
  await t("門檻歷史：提高門檻之前收的單照舊有效", async () => {
    const a2 = { ...multi, thresholds: [{ role: "SOVEREIGN", value: 1, from: 10n }, { role: "SOVEREIGN", value: 3, from: 30n }] };
    const one = await sig(s1);
    assert.equal((await verifyAuthoritySignatures({ role: "SOVEREIGN", signer: s1.address, digest, signature: one, atBlock: 20n }, a2)).ok, true);
    assert.match((await verifyAuthoritySignatures({ role: "SOVEREIGN", signer: s1.address, digest, signature: one, atBlock: 30n }, a2)).reason, /需要 3 個簽章/);
  });

  // CAFECA：keyring 與帳戶都是假的位址，金鑰區間來自假的鏈上事件
  const KEYRING = "0x367a9E8a6E8bA108F4cC4B863d03dD618aD7893b", ACCT = "0x169889ea3ac17d82e81f05cecdcb2a22b548e41e";
  const pk = newPasskey();
  const keyId = keyIdOf(pk.qx, pk.qy);
  const tx = (x) => k256(tb(`tx-${x}`));
  const { book, problems } = buildKeyBook({
    keyring: KEYRING,
    mirrors: [{ account: ACCT, keyId, qx: pk.qx, qy: pk.qy, rpIdHash: pk.rpIdHash, validator: KEYRING, ref: { txHash: tx("add"), logIndex: 3 } }],
    keyLogs: [
      { kind: "added", account: ACCT, keyId, block: 100n, txHash: tx("add"), logIndex: 3 },
      { kind: "removed", account: ACCT, keyId, block: 300n, txHash: tx("rm"), logIndex: 0 },
    ],
    moduleLogs: [{ kind: "installed", account: ACCT, moduleType: 1n, module: KEYRING, block: 50n, logIndex: 0 }],
  });
  const order = { seq: 1n, at: 1n, atBlock: 200n, kind: "place", account: ACCT, nonce: 1n, side: "buy", batchId: 0n, country: "TW", amountKg: 1000n, pricePerTonne: 1n, minFillKg: 0n, expiry: 9n, signature: "0x" };
  const od = digestOf(domains, order);
  const cafeca = (d, opts) => encodeCafecaSignature({ validator: KEYRING, keyId, ...webauthnSign(pk, d, opts) });
  const verifyAt = (signature, atBlock, bk = book) => verifyUserSignature({ account: ACCT, digest: od, signature, atBlock }, bk);

  await t("CAFECA：WebAuthn 簽章以鏈上事件重建的公鑰離線驗過（不讀合約狀態）", async () => {
    assert.deepEqual(problems, []);
    assert.equal((await verifyAt(cafeca(od), 200n)).ok, true);
  });
  await t("CAFECA：金鑰移除之後、登記之前、keyring 沒裝的帳戶，一律拒絕", async () => {
    assert.match((await verifyAt(cafeca(od), 300n)).reason, /不是有效狀態/);
    assert.match((await verifyAt(cafeca(od), 99n)).reason, /不是有效狀態/);
    const noModule = { ...book, modules: new Map() };
    assert.match((await verifyAt(cafeca(od), 200n, noModule)).reason, /沒有安裝 KeyringValidator/);
  });
  await t("CAFECA：簽的是別的 digest、缺 UV 旗標、換了驗證模組、改了公鑰座標，一律拒絕", async () => {
    assert.match((await verifyAt(cafeca(k256(tb("other"))), 200n)).reason, /challenge/);
    assert.match((await verifyAt(cafeca(od, { flags: 0x01 }), 200n)).reason, /UV/);
    const other = encodeCafecaSignature({ validator: "0x0000000000000000000000000000000000000bad", keyId, ...webauthnSign(pk, od) });
    assert.match((await verifyAt(other, 200n)).reason, /不是 CAFECA KeyringValidator/);
    const fake = newPasskey();
    const { problems: p2 } = buildKeyBook({ keyring: KEYRING, keyLogs: [{ kind: "added", account: ACCT, keyId, block: 100n, txHash: tx("add"), logIndex: 3 }], moduleLogs: [],
      mirrors: [{ account: ACCT, keyId, qx: fake.qx, qy: fake.qy, rpIdHash: pk.rpIdHash, validator: KEYRING, ref: { txHash: tx("add"), logIndex: 3 } }] });
    assert.match(p2[0], /座標與 keyId 不符/);
  });
  await t("收單區塊不能往前填到上一期之前（防止回填到金鑰撤銷之前）", async () => {
    const e = { ...order, seq: 5n, atBlock: 150n, account: ACCT, signature: cafeca(od) };
    const bounds = [{ epoch: 1n, lastSeq: 4n, upToBlock: 250n }];
    const sigs = await verifySignatures([e], { domains, authorities: multi, keys: book, boundaries: bounds });
    assert.match(sigs.get("5").reason, /不在所屬那一期的範圍內/);
    const ok = await verifySignatures([{ ...e, atBlock: 260n }], { domains, authorities: multi, keys: book, boundaries: bounds });
    assert.equal(ok.get("5").ok, true);
  });

  // ── 法人帳戶（CAFECA issue #1）：成員以自己的 Passkey 簽 entityHash ──
  const { encodeMemberSignature, entityHashOf } = await import("../lib/ledger/signatures.ts");
  const { buildEntityBook } = await import("../lib/ledger/keybook.ts");
  const MV = "0xA6F02E155B599C366C5B632B42Ad605290284315", ENTITY = "0x00000000000000000000000000000000000e7171", MEMBER = ACCT;
  const KYC_SIGNER = "0xbdd0ea4ef799922b5ad4c31dda9fa6aa8ada5fa1";
  const T0 = 1_800_000_000n;
  const entityBookWith = (extraMember = [], extraIdentity = []) => buildEntityBook({
    memberValidator: MV, chainId: 8018,
    memberLogs: [{ entity: ENTITY, member: MEMBER, role: 2, block: 120n, logIndex: 0 }, ...extraMember],
    identityLogs: [
      { name: "SignerSet", args: { signer: KYC_SIGNER, signerClass: 1 }, block: 10n, logIndex: 0 },
      { name: "Attested", args: { account: MEMBER, subjectType: 0, level: 2, expiry: Number(T0 + 86400n * 365n), signer: KYC_SIGNER, nonce: 1n }, block: 110n, logIndex: 0 },
      ...extraIdentity,
    ],
  });
  const entityBook = (eb = entityBookWith(), mods = [{ module: MV, from: 60n, until: null }]) => {
    const modules = new Map(book.modules); modules.set(ENTITY.toLowerCase(), mods);
    return { ...book, modules, entity: eb };
  };
  const eorder = { ...order, account: ENTITY };
  const ed = digestOf(domains, eorder);
  const memberSig = (d) => encodeMemberSignature({ validator: MV, member: MEMBER, signature: encodeCafecaSignature({ validator: KEYRING, keyId, ...webauthnSign(pk, d) }) });
  const good = memberSig(entityHashOf(8018, MV, ENTITY, ed));
  const verifyEntity = (signature, bk = entityBook(), atBlock = 200n, atTime = T0) => verifyUserSignature({ account: ENTITY, digest: ed, signature, atBlock, atTime }, bk);

  await t("法人帳戶：成員以自己的 Passkey 簽 entityHash，查核只用鏈上事件（成員角色、成員實名、模組、金鑰）就驗得過", async () => {
    assert.equal((await verifyEntity(good)).ok, true);
  });
  await t("法人帳戶：成員直接簽委託單（不是 entityHash）、簽成別的法人、沒有法人設定的金鑰簿，一律拒絕", async () => {
    assert.match((await verifyEntity(memberSig(ed))).reason, /challenge/);
    assert.match((await verifyEntity(memberSig(entityHashOf(8018, MV, "0x00000000000000000000000000000000000e7172", ed)))).reason, /challenge/);
    assert.match((await verifyEntity(memberSig(entityHashOf(8017, MV, ENTITY, ed)))).reason, /challenge/);
    assert.match((await verifyEntity(good, book)).reason, /不是 CAFECA KeyringValidator|格式/);
  });
  await t("法人帳戶：成員被移除之後、成為成員之前、法人沒裝 MemberValidator，一律拒絕", async () => {
    const removed = entityBook(entityBookWith([{ entity: ENTITY, member: MEMBER, role: 0, block: 180n, logIndex: 1 }]));
    assert.match((await verifyEntity(good, removed)).reason, /不是這個法人的成員/);
    assert.equal((await verifyEntity(good, removed, 179n)).ok, true);
    assert.match((await verifyEntity(good, entityBook(), 119n)).reason, /不是這個法人的成員/);
    assert.match((await verifyEntity(good, entityBook(undefined, []))).reason, /沒有安裝 MemberValidator/);
  });
  await t("法人帳戶：成員的實名被暫停、撤銷、過期，或簽章者被移除時，成員簽的單一律拒絕", async () => {
    const sus = entityBook(entityBookWith([], [{ name: "Suspended", args: { account: MEMBER, reason: 5, by: KYC_SIGNER, nonce: 2n }, block: 150n, logIndex: 0 }]));
    assert.match((await verifyEntity(good, sus)).reason, /不是有效的 L2/);
    assert.equal((await verifyEntity(good, sus, 149n)).ok, true);
    const rev = entityBook(entityBookWith([], [{ name: "Revoked", args: { account: MEMBER, reason: 2, by: KYC_SIGNER, nonce: 2n }, block: 150n, logIndex: 0 }]));
    assert.match((await verifyEntity(good, rev)).reason, /不是有效的 L2/);
    assert.match((await verifyEntity(good, entityBook(), 200n, T0 + 86400n * 366n)).reason, /不是有效的 L2/);
    const retired = entityBook(entityBookWith([], [{ name: "SignerSet", args: { signer: KYC_SIGNER, signerClass: 0 }, block: 190n, logIndex: 0 }]));
    assert.match((await verifyEntity(good, retired)).reason, /不是有效的 L2/);
    // 重新簽發（恢復後重驗通過）之後又能簽
    const back = entityBook(entityBookWith([], [
      { name: "Suspended", args: { account: MEMBER, reason: 5, by: KYC_SIGNER, nonce: 2n }, block: 150n, logIndex: 0 },
      { name: "Attested", args: { account: MEMBER, subjectType: 0, level: 2, expiry: Number(T0 + 86400n * 365n), signer: KYC_SIGNER, nonce: 3n }, block: 170n, logIndex: 0 },
    ]));
    assert.equal((await verifyEntity(good, back)).ok, true);
  });
}

// ── CAFECA 實名 → 本站身分 ──
{
  const CI = await import("../lib/ledger/cafeca-identity.ts");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { keccak256: k256, toBytes: tb } = await import("viem");
  const signer = privateKeyToAccount(k256(tb("cafeca-kyc-signer")));
  const REG = "0xFc0E5C11B65aa560fb7187D13f4e1A672894E49c", ACCT = "0x08bd2212f456df7b182973366cdf6d7356a11af9";
  const now = 1_800_000_000;
  const kyc = { subjectType: "person", level: 2, effectiveLevel: 2, status: "active", expiry: now + 86400 * 365, jurisdiction: "TW", nonce: "1", signer: signer.address, signerClass: "prototype" };
  const pairwise = k256(tb("pairwise"));
  const msg = (over = {}) => ({
    account: ACCT, audience: "https://co2.example", nonce: "login-nonce-1", attestationNonce: "1", issuedAt: now - 5, expiresAt: now + 595,
    legalName: "陳大文", docType: "national_id", nationality: "TW", pairwiseId: pairwise, entityUbn: "", entityName: "",
    disclosed: "doc_type,legal_name,nationality,pairwise_id", ...over,
  });
  const cred = async (m) => ({ message: m, signature: await signer.signTypedData(CI.kycCredentialTypedData(8018, REG, m)) });
  const granted = ["handle", "kyc_level", "legal_name", "doc_type", "nationality", "pairwise_id"];
  const verify = async (c, over = {}) => CI.verifyKycCredential(c, { account: ACCT, audience: "https://co2.example", nonce: "login-nonce-1", chainId: 8018, identityRegistry: REG, kyc, granted, now, ...over });

  await t("KYC Credential：CAFECA 簽的姓名、國籍、同一人識別碼驗得過，對應成本站的自然人身分（tier 1，不是 tier 2）", async () => {
    const v = await verify(await cred(msg()));
    assert.equal(v.legal_name, "陳大文"); assert.equal(v.pairwise_id, pairwise); assert.equal(v.credential.signerClass, "prototype");
    const m = CI.ledgerIdentityFrom(kyc, v, "salt");
    assert.equal(m.ok, true); assert.equal(m.identity.tier, 1); assert.equal(m.identity.jurisdiction, "TW"); assert.equal(m.identity.expiry, BigInt(kyc.expiry));
    assert.equal(m.identity.name, "陳大文");
  });
  await t("KYC Credential：別的網站、別次登入、過期、揭露沒同意的項目、別人簽的、證明換過 nonce，一律拒絕", async () => {
    await assert.rejects(verify(await cred(msg({ audience: "https://evil.example" }))), /不是發給本站的/);
    await assert.rejects(verify(await cred(msg({ nonce: "other" }))), /不是這次登入簽發的/);
    await assert.rejects(verify(await cred(msg({ issuedAt: now - 1000, expiresAt: now - 400 }))), /過期/);
    await assert.rejects(verify(await cred(msg()), { granted: ["kyc_level", "legal_name"] }), /沒有同意/);
    const forged = { message: msg(), signature: await privateKeyToAccount(k256(tb("someone"))).signTypedData(CI.kycCredentialTypedData(8018, REG, msg())) };
    await assert.rejects(verify(forged), /簽章者/);
    await assert.rejects(verify(await cred(msg({ attestationNonce: "0" }))), /已變更/);
    await assert.rejects(verify(await cred(msg()), { kyc: { ...kyc, status: "suspended", effectiveLevel: 0 } }), /失效/);
  });
  await t("實名能不能用：原型簽章只在允許時收；暫停、撤銷、L1、過期都不收", async () => {
    assert.equal(CI.usableStatus(kyc, true), null);
    assert.match(CI.usableStatus(kyc, false), /原型簽章/);
    assert.equal(CI.usableStatus({ ...kyc, signerClass: "production" }, false), null);
    assert.match(CI.usableStatus({ ...kyc, status: "suspended", effectiveLevel: 0 }, true), /暫停/);
    assert.match(CI.usableStatus({ ...kyc, status: "revoked", effectiveLevel: 0 }, true), /撤銷/);
    assert.match(CI.usableStatus({ ...kyc, level: 1, effectiveLevel: 1 }, true), /L1/);
    assert.match(CI.usableStatus({ ...kyc, effectiveLevel: 0 }, true), /過期|失效/);
  });
  await t("法人：統編與公司名稱 → tier 2；缺資料不登記；自然人缺同一人識別碼不登記", async () => {
    const ent = { ...kyc, subjectType: "entity" };
    const m = CI.ledgerIdentityFrom(ent, { entity_ubn: "12345678", entity_name: "某某股份有限公司", legal_name: null, nationality: null, pairwise_id: null }, "salt");
    assert.equal(m.identity.tier, 2);
    assert.equal(m.identity.identityHash, k256(tb("TW-UBN:12345678:salt")), "和人工審核同一套雜湊（同一個統編兩條路對得起來）");
    assert.match(CI.ledgerIdentityFrom(ent, { entity_ubn: null, entity_name: "X" }, "s").reason, /統一編號/);
    assert.match(CI.ledgerIdentityFrom(kyc, { legal_name: "陳大文", pairwise_id: null }, "s").reason, /同一人識別碼/);
    assert.match(CI.ledgerIdentityFrom(kyc, { legal_name: "", pairwise_id: pairwise }, "s").reason, /證件姓名/);
  });
  await t("同步：CAFECA 暫停 → 帳本身分到期；重新簽發 → 恢復並延長；只是又能用但 nonce 沒變 → 不自動恢復", async () => {
    const id = { tier: 1, identityHash: k256(tb("h")), expiry: BigInt(kyc.expiry), jurisdiction: "TW" };
    const rec = { tier: 1, status: "approved", identityHash: id.identityHash, attestationNonce: "1" };
    const N = BigInt(now);
    assert.equal(CI.syncPlan({ rec, cur: id, kyc, acceptPrototype: true, now: N }).action, "ok");
    const lapse = CI.syncPlan({ rec, cur: id, kyc: { ...kyc, status: "suspended", effectiveLevel: 0, nonce: "2" }, acceptPrototype: true, now: N });
    assert.equal(lapse.action, "lapsed"); assert.equal(lapse.identity.expiry, N); assert.equal(lapse.record.status, "lapsed");
    const lapsedRec = { ...rec, status: "lapsed", reason: lapse.record.reason, attestationNonce: "1" };
    const lapsedId = { ...id, expiry: N };
    assert.equal(CI.syncPlan({ rec: lapsedRec, cur: lapsedId, kyc, acceptPrototype: true, now: N + 10n }).action, "lapsed", "nonce 沒變：不自動恢復");
    const back = CI.syncPlan({ rec: lapsedRec, cur: lapsedId, kyc: { ...kyc, nonce: "3", expiry: now + 86400 * 400 }, acceptPrototype: true, now: N + 10n });
    assert.equal(back.action, "restored"); assert.equal(back.identity.expiry, BigInt(now + 86400 * 400));
    const renew = CI.syncPlan({ rec, cur: id, kyc: { ...kyc, nonce: "2", expiry: now + 86400 * 500 }, acceptPrototype: true, now: N });
    assert.equal(renew.action, "renewed");
    assert.equal(CI.syncPlan({ rec, cur: id, kyc, acceptPrototype: false, now: N }).action, "lapsed", "正式環境不收原型簽章");
    assert.equal(CI.syncPlan({ rec, cur: id, kyc: { ...kyc, subjectType: "entity" }, acceptPrototype: true, now: N }).action, "lapsed", "主體類型變了");
  });
}

await t("出金請求（規則第 4 版）：現金移到待出金、兩個累計進葉子；退回放回可動用；鏈上確認只能銷待出金", async () => {
  const y = Y.address.toLowerCase();
  // 請求 15 萬、營運方退回 5 萬 → 待出金 10 萬、請求累計 10 萬
  assert.equal(s.pendingWithdraw.get(y), P(100_000n));
  assert.equal(s.withdrawRequested.get(y), P(100_000n));
  const evilSeq = events.find((e) => e.kind === "withdraw" && e.account === EVIL.address).seq;
  assert.match(reasons[String(evilSeq)], /可動用現金不足/);
  const noPayout = events.find((e) => e.kind === "withdraw" && e.account === Z.address).seq;
  assert.match(reasons[String(noPayout)], /沒有指定收款帳戶/);
  const bigReject = events.filter((e) => e.kind === "withdrawReject").at(-1).seq;
  assert.match(reasons[String(bigReject)], /待出金不足以退回/);
  // 葉子：cash 含待出金（仍是帳本欠他的），請求累計 = 10 萬、已出金 = 0
  const b = balancesOf(s).find((x) => x.account.toLowerCase() === y);
  assert.equal(b.cash, s.cash.get(y) + (s.lockedCash.get(y) ?? 0n) + P(100_000n));
  assert.equal(b.withdrawRequested, P(100_000n)); assert.equal(b.withdrawSettled, 0n);
  // 營運方分兩筆匯出 6 萬、4 萬（鏈上 settleWithdrawal 的鏡像）：待出金歸零、已出金 10 萬、可動用不變
  const last = events.at(-1);
  const after = (e, i) => ({ ...e, seq: last.seq + BigInt(i + 1), at: last.at + BigInt(i + 1) });
  const extra = [chain("cashWithdraw", Y, P(60_000n)), chain("cashWithdraw", Y, P(40_000n))].map(after);
  const s2 = apply(genesis(), [...events, ...extra], { sigOk: () => true });
  assert.equal(s2.pendingWithdraw.get(y) ?? 0n, 0n);
  assert.equal(s2.withdrawSettled.get(y), P(100_000n));
  assert.equal(s2.withdrawRequested.get(y), P(100_000n));
  assert.equal(s2.cash.get(y), s.cash.get(y));
  // 超出待出金的鏈上確認（合約本來就擋）：記成被拒絕（要查的事），不從可動用扣
  const s3 = apply(genesis(), [...events, after(chain("cashWithdraw", Y, P(100_001n)), 0)], { sigOk: () => true });
  assert.match(s3.rejected.at(-1).reason, /待出金少於鏈上出金金額/);
  assert.equal(s3.cash.get(y), s.cash.get(y));
});
await t("入金鏡像帶銀行參考號雜湊：它進事件內容（改了就是另一筆），但不影響餘額以外的狀態", async () => {
  const dep = events.find((e) => e.kind === "cashDeposit");
  assert.match(dep.bankRef, /^0x[0-9a-f]{64}$/);
  const { keccak256, toBytes } = await import("viem");
  assert.notEqual(eventHash(dep), eventHash({ ...dep, bankRef: keccak256(toBytes("other")) }));
});
await t("帳本檔案的增量讀取：接著上一次讀到的地方往下讀；寫到一半的最後一行不讀；檔案換了就整份重讀", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { openStore } = await import("../lib/ledger/store.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co2x-store-"));
  const st = openStore(dir);
  const mk = (i) => ({ kind: "policy", individualTransfer: true, individualRetire: false, treasury: "0x0000000000000000000000000000000000000001", signer: "0x0000000000000000000000000000000000000002", signature: "0x", atBlock: BigInt(i) });
  for (let i = 1; i <= 3; i++) await st.append(mk(i));
  assert.equal(st.read().length, 3);
  for (let i = 4; i <= 5; i++) await st.append(mk(i));
  assert.deepEqual(st.read(4n).map((e) => e.seq), [4n, 5n], "只讀新的兩筆");
  assert.deepEqual(st.read(6n), []);
  fs.appendFileSync(path.join(dir, "events.jsonl"), '{"seq":"6n","kind":"pol');   // 寫到一半
  assert.deepEqual(st.read(6n), [], "不完整的最後一行不讀");
  assert.equal(st.read().length, 5);
  // 檔案整份換掉（例如被重建）：序號接不上就重讀
  const other = openStore(fs.mkdtempSync(path.join(os.tmpdir(), "co2x-store-")));
  for (let i = 1; i <= 7; i++) await other.append(mk(i));
  fs.copyFileSync(path.join(other.dir, "events.jsonl"), path.join(dir, "events.jsonl"));
  assert.deepEqual(st.read(6n).map((e) => e.seq), [6n, 7n]);
  assert.equal(st.read().length, 7);
  assert.deepEqual(st.read(2n, 3n).map((e) => e.seq), [2n, 3n]);
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(other.dir, { recursive: true, force: true });
});
await t("鏈上事件的增量索引：舊的區塊段從檔案拿、只讀新的；夠深的才寫檔；換部署就重讀", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { indexedLogs } = await import("../lib/ledger/logindex.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co2x-idx-"));
  const chain = Array.from({ length: 100 }, (_, i) => ({ blockNumber: BigInt(i + 1), v: i + 1 }));
  const calls = [];
  const fetch = async (lo, hi) => { calls.push([lo, hi]); return chain.filter((x) => x.blockNumber >= lo && x.blockNumber <= hi); };
  const q = (toBlock, key = "k") => indexedLogs({ dir, name: "cash", key, confirmations: 10n, fromBlock: 1n, toBlock, blockOf: (x) => x.blockNumber, fetch });
  assert.equal((await q(50n)).length, 50);
  assert.deepEqual(calls.at(-1), [1n, 50n]);
  assert.equal((await q(80n)).length, 80);
  assert.deepEqual(calls.at(-1), [41n, 80n], "從上次寫檔的深度（50 − 10）之後讀");
  assert.equal((await q(30n)).length, 30, "要的範圍比索引舊：不打鏈");
  assert.deepEqual(calls.at(-1), [41n, 80n]);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "cash.json"), "utf8"));
  assert.equal(saved.scannedTo, "70");
  assert.equal((await q(80n, "another-deploy")).length, 80);
  assert.deepEqual(calls.at(-1), [1n, 80n], "部署不同：整份重讀");
  fs.rmSync(dir, { recursive: true, force: true });
});
await t("承諾排程的健康判斷：有事件在等、連心跳都沒有、鏈停了、剛好在門檻上", async () => {
  const { assessLiveness, thresholdsFromEnv } = await import("../lib/ledger/liveness.ts");
  const th = thresholdsFromEnv({});
  assert.deepEqual(th, { lateAfter: 7200, stalledAfter: 21600, heartbeatAfter: 86400 });
  const ev = (...ats) => ats.map((at) => ({ at: BigInt(at) }));
  const T = 1_800_000_000;
  const base = { wallClock: T, chainTime: T, thresholds: th };
  assert.equal(assessLiveness({ ...base, events: [], lastEpoch: null, committedSeq: 0, lastCommittedAt: null }).status, "empty");
  // 全部已進承諾、上一期 10 分鐘前
  let l = assessLiveness({ ...base, events: ev(T - 900, T - 800), lastEpoch: 3, committedSeq: 2, lastCommittedAt: T - 600 });
  assert.equal(l.status, "ok"); assert.equal(l.uncommitted, 0);
  // 最舊的未承諾事件等了 3 小時 → late；7 小時 → stalled
  l = assessLiveness({ ...base, events: ev(T - 20000, T - 3 * 3600, T - 60), lastEpoch: 3, committedSeq: 1, lastCommittedAt: T - 3.5 * 3600 });
  assert.equal(l.status, "late"); assert.equal(l.uncommitted, 2); assert.equal(l.oldestUncommittedAt, T - 3 * 3600);
  l = assessLiveness({ ...base, events: ev(T - 30000, T - 7 * 3600), lastEpoch: 3, committedSeq: 1, lastCommittedAt: T - 8 * 3600 });
  assert.equal(l.status, "stalled"); assert.match(l.reason, /出金請求進不了證據/);
  // 帳本沒有新事件，但上一期是 32 小時前：連空的心跳都沒有 → 提交程式沒在跑（24h 心跳 + 8h > 6h）
  l = assessLiveness({ ...base, events: ev(T - 200000), lastEpoch: 9, committedSeq: 1, lastCommittedAt: T - 32 * 3600 });
  assert.equal(l.status, "stalled"); assert.match(l.reason, /空承諾/);
  // 25 小時：心跳晚了 1 小時，還不算落後
  assert.equal(assessLiveness({ ...base, events: ev(T - 200000), lastEpoch: 9, committedSeq: 1, lastCommittedAt: T - 25 * 3600 }).status, "ok");
  // 鏈停了：區塊時間不動，只看它會以為正常——取牆上時鐘
  l = assessLiveness({ wallClock: T, chainTime: T - 10 * 3600, thresholds: th, events: ev(T - 9 * 3600), lastEpoch: 2, committedSeq: 0, lastCommittedAt: T - 10 * 3600 });
  assert.equal(l.status, "stalled");
  // 本機鏈快轉：區塊時間比牆上時鐘晚，取較大者
  assert.equal(assessLiveness({ wallClock: T, chainTime: T + 30 * 86400, thresholds: th, events: ev(T), lastEpoch: 1, committedSeq: 0, lastCommittedAt: T }).status, "stalled");
  // 門檻：剛好 2 小時就是 late
  assert.equal(assessLiveness({ ...base, events: ev(T - 7200), lastEpoch: null, committedSeq: 0, lastCommittedAt: null }).status, "late");
  // 門檻設定：stalled 不會小於 late
  assert.deepEqual(thresholdsFromEnv({ COMMIT_LATE_AFTER: "36000", COMMIT_STALLED_AFTER: "60" }).stalledAfter, 36000);
});
console.log(`\n${n} 個測試通過（事件 ${events.length} 筆，拒絕 ${s.rejected.length} 筆，成交 ${s.fills.length} 筆）`);
