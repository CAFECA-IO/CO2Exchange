#!/usr/bin/env node
// 個人資料加密（lib/crypto/sealed.ts）與遷移（scripts/data-protect.mjs）的測試。不需要鏈。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const S = await import("../lib/crypto/sealed.ts");
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

const k1 = S.parseDataKey(crypto.randomBytes(32).toString("base64"));
const k2 = S.parseDataKey(`0x${crypto.randomBytes(32).toString("hex")}`);
const A = "0x00000000000000000000000000000000000000Aa", B = "0x00000000000000000000000000000000000000bB";
const aad = (acct) => S.aadOf("payout-accounts", "accountNo", acct);

t("加密後解得回來，同一個值兩次加密結果不同", () => {
  const x = S.seal("00012345678901", k1, aad(A)), y = S.seal("00012345678901", k1, aad(A));
  assert.ok(S.isSealed(x) && x !== y && !x.includes("00012345678901"));
  assert.equal(S.open(x, [k1], aad(A)), "00012345678901");
  assert.equal(S.open(x, [k1], aad(A.toLowerCase())), "00012345678901", "地址大小寫不影響");
});
t("貼到別人的紀錄上解不開（AAD 綁帳戶與欄位）", () => {
  const x = S.seal("A123456789", k1, aad(A));
  assert.throws(() => S.open(x, [k1], aad(B)), (e) => e.reason === "auth-failed");
  assert.throws(() => S.open(x, [k1], S.aadOf("payout-accounts", "holder", A)), (e) => e.reason === "auth-failed");
});
t("密文改一個字元就驗證失敗", () => {
  const x = S.seal("王小明", k1, aad(A));
  const parts = x.split(":"); const ct = parts[4];
  parts[4] = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
  assert.throws(() => S.open(parts.join(":"), [k1], aad(A)), (e) => e.reason === "auth-failed");
});
t("換金鑰：舊金鑰加密的只要還在清單上就讀得到；不在就說是哪一把", () => {
  const x = S.seal("x", k1, aad(A));
  assert.equal(S.open(x, [k2, k1], aad(A)), "x");
  assert.throws(() => S.open(x, [k2], aad(A)), (e) => e.reason === "no-key" && e.message.includes(k1.kid) && !e.message.includes("x\""));
});
t("金鑰格式錯誤的訊息不回顯內容", () => {
  const bad = "not-a-key-but-secret-looking-0123456789";
  assert.throws(() => S.parseDataKey(bad), (e) => !e.message.includes(bad));
});
t("遮罩", () => {
  assert.equal(S.maskTail("00012345678901"), "••••••••••8901");
  assert.equal(S.maskIdNumber("A123456789"), "A•••••••89");
});

// ── 遷移：web/data 與備份裡的明文 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "co2x-protect-"));
const mk = (dir, kyc, pay) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "kyc-requests.json"), JSON.stringify(kyc));
  if (pay) fs.writeFileSync(path.join(dir, "payout-accounts.json"), JSON.stringify(pay));
};
const kycRows = [
  { id: "a1", account: A, tier: 1, idNumber: "A123456789", name: "王小明", status: "approved", createdAt: "", updatedAt: "" },
  { id: "a2", account: B, tier: 2, idNumber: "12345678", name: "某某股份有限公司", status: "pending", createdAt: "", updatedAt: "" },
];
const payRows = [{ id: "p1", account: A, bankCode: "812", accountNo: "00012345678901", holder: "王小明", payoutRef: "0x01", createdAt: "", updatedAt: "" }];
mk(path.join(TMP, "data"), kycRows, payRows);
mk(path.join(TMP, "data.bak-2026-01-01T00-00-00"), kycRows);
const KEY = crypto.randomBytes(32).toString("base64");
const run = (...args) => execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/data-protect.mjs", ...args], {
  env: { ...process.env, DATA_DIR: path.join(TMP, "data"), DATA_KEY: KEY, CHAIN_ID: "8018", ENV_FILE: path.join(TMP, "none.env") }, encoding: "utf8",
});
const plain = ["A123456789", "12345678", "王小明", "某某股份有限公司", "00012345678901"];
const grepAll = () => {
  const hits = [];
  for (const d of fs.readdirSync(TMP)) for (const f of fs.readdirSync(path.join(TMP, d))) {
    const s = fs.readFileSync(path.join(TMP, d, f), "utf8");
    for (const p of plain) if (s.includes(p)) hits.push(`${d}/${f}:${p}`);
  }
  return hits;
};

t("--dry-run 只數，不改檔案，也不印出任何值", () => {
  const out = run("--dry-run");
  assert.ok(grepAll().length > 0);
  for (const p of plain) assert.ok(!out.includes(p), "輸出不含明文");
  assert.match(out, /2 個資料夾/);
});
t("遷移後 web/data 與備份都沒有明文；審核完的證號刪掉、待審的加密", () => {
  const out = run();
  for (const p of plain) assert.ok(!out.includes(p));
  assert.deepEqual(grepAll(), []);
  const k = JSON.parse(fs.readFileSync(path.join(TMP, "data", "kyc-requests.json"), "utf8"));
  assert.equal(k[0].idNumberSealed, undefined); assert.equal(k[0].idNumberMasked, "A•••••••89");
  const key = S.parseDataKey(KEY);
  assert.equal(S.open(k[1].idNumberSealed, [key], S.aadOf("kyc-requests", "idNumber", B)), "12345678");
  assert.equal(S.open(k[0].nameSealed, [key], S.aadOf("kyc-requests", "name", A)), "王小明");
  const p = JSON.parse(fs.readFileSync(path.join(TMP, "data", "payout-accounts.json"), "utf8"));
  assert.equal(p[0].accountNoMasked, "••••••••••8901");
  assert.equal(S.open(p[0].accountNoSealed, [key], S.aadOf("payout-accounts", "accountNo", A)), "00012345678901");
});
t("重跑不再改任何東西", () => {
  const before = fs.readFileSync(path.join(TMP, "data", "payout-accounts.json"), "utf8");
  assert.match(run(), /0 個檔案改寫/);
  assert.equal(fs.readFileSync(path.join(TMP, "data", "payout-accounts.json"), "utf8"), before);
});
t("--rekey：換新金鑰、舊的放 DATA_KEY_PREVIOUS，資料改用新金鑰", () => {
  const NEW = crypto.randomBytes(32).toString("base64");
  execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/data-protect.mjs", "--rekey"], {
    env: { ...process.env, DATA_DIR: path.join(TMP, "data"), DATA_KEY: NEW, DATA_KEY_PREVIOUS: KEY, CHAIN_ID: "8018", ENV_FILE: path.join(TMP, "none.env") }, encoding: "utf8",
  });
  const p = JSON.parse(fs.readFileSync(path.join(TMP, "data", "payout-accounts.json"), "utf8"));
  assert.equal(S.open(p[0].accountNoSealed, [S.parseDataKey(NEW)], S.aadOf("payout-accounts", "accountNo", A)), "00012345678901");
  assert.throws(() => S.open(p[0].accountNoSealed, [S.parseDataKey(KEY)], S.aadOf("payout-accounts", "accountNo", A)));
});
t("外部鏈沒有 DATA_KEY 就拒絕執行", () => {
  assert.throws(() => execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/data-protect.mjs"], {
    env: { ...process.env, DATA_DIR: path.join(TMP, "data"), DATA_KEY: "", CHAIN_ID: "8018", ENV_FILE: path.join(TMP, "none.env") }, stdio: "pipe",
  }));
});
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} 個測試通過`);
