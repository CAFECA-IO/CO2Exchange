// scripts/lib/keys.mjs 的測試。每個案例在子行程裡跑（keys.mjs 在載入時讀檔一次）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co2x-keys-"));
const GOOD = "0x" + "1f".repeat(32);
const GOOD2 = "0x" + "2e".repeat(32);
const ANVIL = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const lib = path.resolve("scripts/lib/keys.mjs");

function run({ file, env = {}, chainId = 8018, isLocal = false, names = ["DEPLOYER_PK", "RELAYER_PK"] }) {
  const f = path.join(dir, `env-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(f, file ?? "");
  const code = `
    import { keyring } from ${JSON.stringify(lib)};
    try { const k = keyring({ chainId: ${chainId}, isLocal: ${isLocal} }).require(...${JSON.stringify(names)});
      console.log(JSON.stringify({ ok: true, name: k.name, source: k.source, pk: k.pk })); }
    catch (e) { console.log(JSON.stringify({ ok: false, msg: e.message })); }`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith("_PK")));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...clean, ENV_FILE: f, ...env }, encoding: "utf8" });
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`); };

t("檔案裡的金鑰會被讀到", () => {
  const r = run({ file: `CHAIN_ID=8018\nDEPLOYER_PK=${GOOD}\n` });
  assert.equal(r.ok, true); assert.equal(r.pk, GOOD); assert.equal(r.source, "web/.env.local");
});
t("shell 的值優先於檔案", () => {
  const r = run({ file: `CHAIN_ID=8018\nDEPLOYER_PK=${GOOD}\n`, env: { DEPLOYER_PK: GOOD2 } });
  assert.equal(r.pk, GOOD2); assert.equal(r.source, "shell");
});
t("shell 裡的 README 佔位字 0x… → 指名變數、建議 unset、不回顯值", () => {
  const r = run({ file: `CHAIN_ID=8018\nDEPLOYER_PK=${GOOD}\n`, env: { DEPLOYER_PK: "0x…" } });
  assert.equal(r.ok, false);
  assert.match(r.msg, /DEPLOYER_PK/); assert.match(r.msg, /unset DEPLOYER_PK/); assert.match(r.msg, /佔位字/);
});
t("錯誤訊息不含私鑰本身（長度不對的真金鑰）", () => {
  const bad = GOOD.slice(0, 60);
  const r = run({ env: { DEPLOYER_PK: bad } });
  assert.equal(r.ok, false); assert.ok(!r.msg.includes(bad.slice(2, 20)), "訊息洩漏了金鑰內容");
});
t("檔案的 CHAIN_ID 與目前的鏈不同 → 不採用檔案裡的金鑰", () => {
  const r = run({ file: `CHAIN_ID=8018\nDEPLOYER_PK=${GOOD}\n`, chainId: 31337, isLocal: true });
  assert.equal(r.ok, true); assert.equal(r.name, "ANVIL_PK0");
});
t("公開鏈上沒有金鑰 → 報錯，不退回 anvil", () => {
  const r = run({ file: "" });
  assert.equal(r.ok, false); assert.match(r.msg, /DEPLOYER_PK 或 RELAYER_PK/);
});
t("公開鏈上拒絕 anvil 預設金鑰", () => {
  const r = run({ env: { DEPLOYER_PK: ANVIL } });
  assert.equal(r.ok, false); assert.match(r.msg, /公開預設金鑰/);
});
t("第一個沒有就找下一個（RELAYER_PK）", () => {
  const r = run({ file: `CHAIN_ID=8018\nRELAYER_PK=${GOOD}\n` });
  assert.equal(r.name, "RELAYER_PK");
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} 個測試通過`);
