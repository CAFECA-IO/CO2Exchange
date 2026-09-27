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

test("不是本站發的 nonce 驗不過（改掉 HMAC）", () => {
  const { nonce } = newNonce();
  const [rand, exp] = nonce.split("~");
  assert.match(consumeNonce(`${rand}~${exp}~${"A".repeat(27)}`) ?? "", /不是本站/);
});

test("改掉到期時間也驗不過——HMAC 蓋住的是整個 body", () => {
  const { nonce } = newNonce();
  const [rand, , mac] = nonce.split("~");
  const far = Math.floor(Date.now() / 1000) + 86400;
  assert.match(consumeNonce(`${rand}~${far}~${mac}`) ?? "", /不是本站/);
});

test("HMAC 正確但已經過期的 nonce 被擋", () => {
  // 用同一把金鑰自己偽造一個「過去發出、已經過期」的 nonce：
  // HMAC 會對，所以擋下它的只能是時間檢查。這正是要測的那一條路。
  const rand = crypto.randomBytes(18).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) - 60;
  const body = `${rand}~${exp}`;
  const mac = crypto.createHmac("sha256", process.env.AUTH_SECRET).update(body).digest("base64url").slice(0, 27);
  assert.match(consumeNonce(`${body}~${mac}`) ?? "", /過期/);
});

test("格式不對的直接擋掉，不進雜湊比對", () => {
  for (const bad of ["", "short", "a".repeat(200), "has space", "a~b"]) {
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

console.log(`\n${n} 項全部通過。`);
