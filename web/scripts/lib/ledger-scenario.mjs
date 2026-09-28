// 帳本 v2 的測試情境：一組角色、授權清單、以及一串涵蓋所有事件種類的事件。
// test-ledger.mjs 與 gen-ledger-fixture.mjs 共用——跨語言 fixture 與單元測試跑的是同一份情境。
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { authTypedData, userTypedData, userMessageOf } = await import("../../lib/ledger/typed.ts");

export async function buildScenario() {
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
  await push(place(X, "sell", 1n, "", 10_000n, 800n));
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
  await push(auth(D, "reserveReport", { period: 202609, asOf: clock, credits: [{ country: "TW", custodian: "環境部", accountRef: "TW-1", heldKg: 48_000n, ledgerKg: 48_000n, statementHash: keccak256(toBytes("s")) }], cash: { trustee: "某銀行", accountRef: "T-1", balance: P(1_100_000n), tokenSupply: P(1_100_000n), statementHash: keccak256(toBytes("c")) }, documentHash: keccak256(toBytes("r")) }));
  await push(auth(A, "reserveAttest", { reportId: 1n, status: 1, auditorName: "某會計師事務所", note: "相符" }));
  block = 600n;
  await push(issue(1n, 1_000n, 4));                                                                                           // 拒絕：C 的授權到 500 為止


  return {
    events, domains, authorities, actors: { S, I, C, D, A, O, X, Y, Z, T, EVIL },
    factory: { auth, user, chain, id, issue, place, acct, P, reset: () => { seq = 0n; }, now: () => clock },
  };
}
