#!/usr/bin/env node
/**
 * 從 out/ 的編譯產物抽出所有自訂 error，寫成 web/lib/error-abi.ts。
 *
 * 為什麼需要：revert 回到前端只剩四個位元組的 selector，沒有 error 定義就解不開。
 * `PasskeyAccount.execute` 更是把真正的錯誤包在 `CallFailed(index, reason)` 裡，
 * 不拆開的話畫面上只有一句 `0x5c0dee5d`，誰也不知道發生什麼事。
 *
 *   cd web && node scripts/gen-error-abi.mjs
 *
 * 合約改了自訂 error 就要重跑一次（見 README「營運手冊 › 更新」）。
 */
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(process.cwd(), "..", "out");
const DEST = path.resolve(process.cwd(), "lib", "error-abi.ts");
if (!fs.existsSync(OUT)) {
  console.error(`找不到 ${OUT}。先在專案根目錄跑 forge build。`);
  process.exit(1);
}

const seen = new Map();
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith(".json")) continue;
    // 測試工具的 error 不需要，使用者不會看到它們
    if (p.includes("/forge-std/") || p.includes("/test/")) continue;
    let abi;
    try { abi = JSON.parse(fs.readFileSync(p, "utf8")).abi ?? []; } catch { continue; }
    for (const it of abi) {
      if (it.type !== "error") continue;
      const key = `${it.name}(${(it.inputs ?? []).map((c) => c.type).join(",")})`;
      if (!seen.has(key)) seen.set(key, it);
    }
  }
};
walk(OUT);

const rows = [...seen.keys()].sort().map((k) => {
  const it = seen.get(k);
  const ins = (it.inputs ?? []).map((c) => `{ name: "${c.name ?? ""}", type: "${c.type}" }`).join(", ");
  return `  { type: "error", name: "${it.name}", inputs: [${ins}] },`;
});

fs.writeFileSync(DEST, `/// 平台上所有合約的自訂 error——由 scripts/gen-error-abi.mjs 產生，請勿手改。
///
/// 用途只有一個：**把 revert 的四個位元組翻譯成人看得懂的字**。
///
/// 前端其他的 ABI 常數都只放 function，因為呼叫只需要那些；
/// 但 revert 回來的是一個 selector，沒有對應的 error 定義就解不開，
/// 使用者看到的會是 \`0x5c0dee5d\` 這種東西。\`PasskeyAccount.execute\` 尤其嚴重：
/// 它把真正的錯誤包在 \`CallFailed(index, reason)\` 的 reason 裡，
/// 不拆開就等於把診斷資訊整個丟掉。
///
/// 合約改了自訂 error 就要重跑：\`cd web && node scripts/gen-error-abi.mjs\`

export const errorAbi = [
${rows.join("\n")}
  // Solidity 內建的兩個：revert("...") 與 assert 失敗
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
  { type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] },
] as const;
`);
console.log(`寫入 ${rows.length} 個 error 定義 → lib/error-abi.ts`);
