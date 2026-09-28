#!/usr/bin/env node
/**
 * 「以 CAFECA 登入」的兩個要害：nonce 與 digest。
 *
 *   cd web && npm run test:cafeca
 *
 * 跑的時候要帶 `--conditions=react-server`：被測的模組標了 `server-only`，
 * 而那個套件的預設進入點**故意會 throw**（它存在的意義就是讓 client 端 import 它就爆）。
 * `react-server` 這個條件會解析到它的空檔，也就是 Next 在伺服器端用的那一份。
 *
 * 為什麼只測這兩樣：完整的登入驗證要有一條鏈與一個真的身分合約（ERC-1271 是
 * 一次 eth_call），那屬於 e2e。但這兩樣是**純函式**，而且它們壞掉的方式最安靜：
 *   · nonce 的重送保護失效 —— 功能一切正常，只是簽章可以被重複使用。
 *   · digest 少算一個欄位 —— 驗證照樣會過，只是不同的訊息得到同一個 digest，
 *     於是一個情境下取得的簽章可以搬到另一個情境用。
 * 兩者都不會有任何畫面顯示出問題，所以要有測試盯著。
 */
process.env.AUTH_SECRET ??= "test-secret-do-not-use-in-production";
import crypto from "node:crypto";
import assert from "node:assert/strict";

const { newNonce, consumeNonce } = await import("../lib/server/cafeca/nonce.ts");
const { signInDigest } = await import("../lib/server/cafeca/digest.ts");
const O = await import("../lib/bank/order-typed.ts");
const C = await import("../lib/server/cafeca/parse-config.ts");

let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`); };

console.log("nonce");

test("剛發出來的 nonce 可以用一次", () => {
  assert.equal(consumeNonce(newNonce().nonce), null);
});

test("同一個 nonce 用第二次會被擋——這就是重送保護本身", () => {
  const { nonce } = newNonce();
  assert.equal(consumeNonce(nonce), null);
  assert.match(consumeNonce(nonce) ?? "", /用過/);
});

// nonce 的版面：隨機 24 ＋ 到期秒 10 ＋ HMAC 27（沒有分隔符，見 nonce.ts）
const split = (n) => [n.slice(0, 24), n.slice(24, 34), n.slice(34)];

test("nonce 符合 CAFECA 錢包的規格：8–128 字元的 [A-Za-z0-9_-]", () => {
  for (let i = 0; i < 200; i++) {
    const { nonce } = newNonce();
    assert.match(nonce, /^[A-Za-z0-9_-]{8,128}$/);
    assert.equal(nonce.length, 61);
  }
});

test("不是本站發的 nonce 驗不過（改掉 HMAC）", () => {
  const [rand, exp] = split(newNonce().nonce);
  assert.match(consumeNonce(`${rand}${exp}${"A".repeat(27)}`) ?? "", /不是本站/);
});

test("改掉到期時間也驗不過——HMAC 蓋住的是整個 body", () => {
  const [rand, , mac] = split(newNonce().nonce);
  const far = String(Math.floor(Date.now() / 1000) + 86400).padStart(10, "0");
  assert.match(consumeNonce(`${rand}${far}${mac}`) ?? "", /不是本站/);
});

test("HMAC 正確但已經過期的 nonce 被擋", () => {
  // 用同一把金鑰自己偽造一個「過去發出、已經過期」的 nonce：
  // HMAC 會對，所以擋下它的只能是時間檢查。這正是要測的那一條路。
  const rand = crypto.randomBytes(18).toString("base64url");
  const exp = String(Math.floor(Date.now() / 1000) - 60).padStart(10, "0");
  const mac = crypto.createHmac("sha256", process.env.AUTH_SECRET).update(`${rand}.${exp}`).digest("base64url").slice(0, 27);
  assert.match(consumeNonce(`${rand}${exp}${mac}`) ?? "", /過期/);
});

test("格式不對的直接擋掉，不進雜湊比對", () => {
  for (const bad of ["", "short", "a".repeat(200), "has space", "a~b", `${"a".repeat(24)}~${"1".repeat(9)}${"b".repeat(27)}`, "a".repeat(61)]) {
    assert.notEqual(consumeNonce(bad), null, `應該擋掉：${bad}`);
  }
});

console.log("digest");

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const base = {
  domain: "https://shop.example",
  uri: "https://shop.example/login",
  nonce: "abcdefgh",
  issuedAt: 1_700_000_000n,
  expiresAt: 1_700_000_300n,
  statement: "登入 Example Shop",
  claims: "handle,kyc_level",
};

test("同樣的輸入每次都得到同樣的 digest", () => {
  assert.equal(signInDigest(8018, ACCOUNT, base), signInDigest(8018, ACCOUNT, { ...base }));
});

test("換網域就換 digest——這是防仿冒的根", () => {
  assert.notEqual(signInDigest(8018, ACCOUNT, base), signInDigest(8018, ACCOUNT, { ...base, domain: "https://evil.example" }));
});

test("換帳戶就換 digest——別人的簽章搬不過來", () => {
  assert.notEqual(signInDigest(8018, ACCOUNT, base), signInDigest(8018, OTHER, base));
});

test("換鏈就換 digest——測試網的簽章不能拿到主網用", () => {
  assert.notEqual(signInDigest(8018, ACCOUNT, base), signInDigest(8017, ACCOUNT, base));
});

test("每一個欄位都進雜湊——少算一個就是可以被搬用的簽章", () => {
  const ref = signInDigest(8018, ACCOUNT, base);
  const variants = {
    uri: "https://shop.example/other",
    nonce: "zzzzzzzz",
    issuedAt: base.issuedAt + 1n,
    expiresAt: base.expiresAt + 1n,
    statement: "別的說明",
    claims: "kyc_level",
  };
  for (const [k, v] of Object.entries(variants)) {
    assert.notEqual(signInDigest(8018, ACCOUNT, { ...base, [k]: v }), ref, `${k} 沒有進雜湊`);
  }
});

test("SignIn 有第八個欄位 channel（CAFECA README）：型別字串與錢包一致", async () => {
  // 不靠 digest.ts：照 README 的型別字串自己算一次 EIP-712，兩邊必須相同
  const { keccak256, toBytes, encodeAbiParameters, hashDomain, concat } = await import("viem");
  const TYPE = "SignIn(string domain,string uri,string nonce,uint256 issuedAt,uint256 expiresAt,string statement,string claims,string channel)";
  const m = { ...base, channel: "" };
  const h = (x) => keccak256(toBytes(x));
  const structHash = keccak256(encodeAbiParameters(
    ["bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint256", "bytes32", "bytes32", "bytes32"].map((type) => ({ type })),
    [h(TYPE), h(m.domain), h(m.uri), h(m.nonce), m.issuedAt, m.expiresAt, h(m.statement), h(m.claims), h(m.channel)],
  ));
  const sep = hashDomain({
    domain: { name: "CAFECA Sign-In", version: "1", chainId: 8018, verifyingContract: ACCOUNT },
    types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] },
  });
  assert.equal(signInDigest(8018, ACCOUNT, m), keccak256(concat(["0x1901", sep, structHash])));
});

test("channel 進雜湊：空字串和沒有這個欄位（舊版錢包）是不同的 digest，換通道也換 digest", () => {
  const withEmpty = signInDigest(8018, ACCOUNT, { ...base, channel: "" });
  assert.notEqual(withEmpty, signInDigest(8018, ACCOUNT, base));
  assert.notEqual(withEmpty, signInDigest(8018, ACCOUNT, { ...base, channel: "ch_123" }));
});

console.log("委託單 EIP-712");

const BANK = "0x3333333333333333333333333333333333333333";
const order = {
  account: ACCOUNT, side: "sell", batchId: "7", country: "TW",
  amountKg: "1000", pricePerTonne: "800000000", minFillKg: "0",
  expiry: "1800000000", nonce: "3",
};

test("同樣的單每次都得到同樣的 digest", () => {
  assert.equal(O.placeDigest(8018, BANK, order), O.placeDigest(8018, BANK, { ...order }));
});

test("每一個欄位都進雜湊——少算一個就是可以被改掉的委託單", () => {
  const ref = O.placeDigest(8018, BANK, order);
  const variants = {
    account: OTHER, side: "buy", batchId: "8", country: "JP",
    amountKg: "1001", pricePerTonne: "800000001", minFillKg: "1",
    expiry: "1800000001", nonce: "4",
  };
  for (const [k, v] of Object.entries(variants)) {
    assert.notEqual(O.placeDigest(8018, BANK, { ...order, [k]: v }), ref, `${k} 沒有進雜湊`);
  }
});

test("換 Bank 或換鏈就換 digest——這張單是對這個池子、這條鏈下的", () => {
  const ref = O.placeDigest(8018, BANK, order);
  assert.notEqual(O.placeDigest(8018, OTHER, order), ref);
  assert.notEqual(O.placeDigest(8017, BANK, order), ref);
});

test("十進位字串與 bigint 給出同一個 digest", () => {
  // 線上傳的是字串（JSON 沒有 bigint，錢包也要求字串），而 log 裡是 bigint。
  // 兩邊算出來必須一樣，否則收單時驗得過、事後重播時就驗不過了。
  const fromLog = O.placeMessageOf({
    account: ACCOUNT, side: "sell", batchId: 7n, country: "TW",
    amountKg: 1000n, pricePerTonne: 800_000_000n, minFillKg: 0n,
    expiry: 1_800_000_000n, nonce: 3n,
  });
  assert.deepEqual(fromLog, order);
  assert.equal(O.placeDigest(8018, BANK, fromLog), O.placeDigest(8018, BANK, order));
});

test("撤單也是簽過的，而且換一張單就換 digest", () => {
  const c = { account: ACCOUNT, orderSeq: "12", nonce: "4" };
  assert.equal(O.cancelDigest(8018, BANK, c), O.cancelDigest(8018, BANK, { ...c }));
  assert.notEqual(O.cancelDigest(8018, BANK, { ...c, orderSeq: "13" }), O.cancelDigest(8018, BANK, c));
  assert.deepEqual(O.cancelMessageOf({ account: ACCOUNT, orderSeq: 12n, nonce: 4n }), c);
});

test("網域不能撞上錢包會拒絕的那幾種", () => {
  // CAFECA 錢包會擋下網域名稱是 CAFECA Sign-In / ERC4337 的 EIP-712，
  // 也會擋下 verifyingContract 指向使用者帳戶、EntryPoint 或 CAFECA 系統合約的。
  // 這一條看起來像廢話，但它守的是「有人為了省事把網域改成登入那一組」——
  // 那樣做的當下功能正常，直到錢包某次更新把它擋下來為止。
  assert.notEqual(O.ORDER_DOMAIN_NAME, "CAFECA Sign-In");
  assert.notEqual(O.ORDER_DOMAIN_NAME, "ERC4337");
  const td = O.placeTypedData(8018, BANK, order);
  assert.equal(td.domain.verifyingContract, BANK);
  assert.notEqual(td.domain.verifyingContract.toLowerCase(), order.account.toLowerCase());
});

console.log("設定檔解析");

// cafeca.io/.well-known/cafeca-configuration 在 2026-09-28 真正回的位元組。
// 用真的那一份當 fixture，因為第一版就是照**摘要過**的文件寫的，
// 漏掉了 chain 是巢狀的——編得過、型別也對，只有真的連上去才會炸。
const REAL = JSON.parse(`{"issuer":"http://localhost:10002","protocol":"cafeca-signin","versions":[1],"authorization_endpoint":"http://localhost:10002/dl/auth","custom_scheme":"cafeca://auth","sdk":"http://localhost:10002/sdk/cafeca-connect.js","modes":["popup","redirect","post"],"channel":{"endpoint":"http://localhost:10002/dl/sign","relay":"http://localhost:10002/api/channel","methods":["sign_message","sign_typed_data","send_calls"],"max_ttl_seconds":2592000},"claims_supported":["kyc_level","handle"],"max_ttl_seconds":600,"chain":{"id":8018,"rpc":"https://boltchain.cafeca.io"},"contracts":{"factory":"0x075e377D1096089aE2D44fbD23156BF900b8bd24","keyring":"0x367a9E8a6E8bA108F4cC4B863d03dD618aD7893b","attestation":"0x4b08B5063eE773C084dD9E67E09690aF8cb2A880","recovery":"0xA199a3f7afd81bDBC6CE697400Fa44d5b6a16594","twdc":"0xb07f90B82eEb0269fAcafC5A6a6CC01BE4747bA3","entryPoint":"0xc99102a99B61c9968Db66fa974E69e37b45EFEDE"},"eip712":{"name":"CAFECA Sign-In","version":"1","primaryType":"SignIn","verifyingContract":"<account>"}}`);

test("讀得懂真正的設定檔（chain 是巢狀的，不是平鋪的 chainId）", () => {
  const c = C.parseConfig(REAL);
  assert.equal(c.chainId, 8018);
  assert.equal(c.rpcUrl, "https://boltchain.cafeca.io");
  assert.equal(c.contracts.attestation, "0x4b08B5063eE773C084dD9E67E09690aF8cb2A880");
  assert.equal(c.contracts.twdc, "0xb07f90B82eEb0269fAcafC5A6a6CC01BE4747bA3");
  assert.equal(c.contracts.entryPoint, "0xc99102a99B61c9968Db66fa974E69e37b45EFEDE");
});

test("平鋪的形狀也讀得懂——對方哪天改格式不該整站登不進去", () => {
  const c = C.parseConfig({ chainId: 8018, rpc: "https://x", contracts: REAL.contracts });
  assert.equal(c.chainId, 8018);
  assert.equal(c.rpcUrl, "https://x");
});

test("認得出這是開發版錢包的設定檔（端點全在 localhost）", () => {
  assert.equal(C.looksLocal(C.parseConfig(REAL)), true);
  assert.equal(C.looksLocal(C.parseConfig({ ...REAL, issuer: "https://cafeca.io" })), false);
});

test("缺欄位或壞地址一律拒絕，不要拿一個空地址去驗簽章", () => {
  const bad = [
    {},
    { chain: { id: 0 }, contracts: REAL.contracts },
    { chain: { id: 8018 }, contracts: {} },
    { chain: { id: 8018 }, contracts: { ...REAL.contracts, attestation: "0xnope" } },
  ];
  for (const b of bad) assert.throws(() => C.parseConfig(b), C.ConfigError);
});

console.log(`\n${n} 項全部通過。`);
