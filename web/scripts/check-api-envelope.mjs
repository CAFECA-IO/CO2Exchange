#!/usr/bin/env node
// 所有 API 都要走 lib/server/api.ts 回應——這支腳本負責讓這句話一直成立。
//
// 為什麼需要它：統一回應形狀是一次性的重構，但**破壞它只要一行**。
// 下一個人趕時間時最自然的寫法就是 `return Response.json({ error: "bad" }, { status: 400 })`，
// 那一行不會讓任何測試變紅，只會讓前端多一種它不認得的錯誤形狀——
// 而前端的 catch 拿不到 code，就只能把英文字串原樣顯示給使用者。
//
// 規則：
//   1. app/api/**/route.ts 不得直接呼叫 Response.json / new Response / NextResponse.json。
//   2. 錯誤一律帶 error code：不得 `fail("字面字串")`，code 必須是 ERRORS 裡的鍵。
//   3. route 必須 import ok 或 fail（純轉址或串流的例外要明確標注）。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const API = path.join(ROOT, "app/api");

/// 少數合理的例外：回傳的不是 JSON（PDF、圖片、串流）。
/// 要豁免必須在檔案裡寫明理由，避免「加一行註解就繞過」變成習慣。
const OPT_OUT = /@api-envelope-exempt:\s*\S+/;

const codes = new Set(
  [...fs.readFileSync(path.join(ROOT, "lib/error-codes.ts"), "utf8").matchAll(/^\s{2}([A-Z][A-Z_]+):\s*\{/gm)]
    .map((m) => m[1]),
);
if (codes.size < 10) {
  console.error("讀不到 lib/error-codes.ts 的錯誤碼清單，檢查一下那個檔案的格式。");
  process.exit(1);
}

function* routes(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* routes(p);
    else if (e.name === "route.ts") yield p;
  }
}

const bad = [];
let checked = 0;
for (const file of routes(API)) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, "utf8");
  const exempt = OPT_OUT.test(src);
  checked++;

  src.split(/\r?\n/).forEach((line, i) => {
    const n = i + 1;
    if (/^\s*(\/\/|\/\*|\*|\/\/\/)/.test(line)) return; // 註解裡提到是在解釋規則

    if (!exempt && /\b(Response|NextResponse)\.json\s*\(/.test(line)) {
      bad.push({ rel, n, line: line.trim(), why: "直接回 Response.json。改用 lib/server/api 的 ok() / fail()。" });
    }
    if (!exempt && /\bnew Response\s*\(/.test(line)) {
      bad.push({ rel, n, line: line.trim(), why: "直接 new Response。非 JSON 的回應請在檔案頂端標注 @api-envelope-exempt: <理由>。" });
    }
    // fail("…") 的第一個參數必須是已定義的錯誤碼
    for (const m of line.matchAll(/\bfail\(\s*"([^"]+)"/g)) {
      if (!codes.has(m[1])) {
        bad.push({ rel, n, line: line.trim(), why: `「${m[1]}」不在 lib/error-codes.ts 裡。錯誤碼是對外契約，要先在那裡定義。` });
      }
    }
    // throw new ApiError("…") 同理
    for (const m of line.matchAll(/new ApiError\(\s*"([^"]+)"/g)) {
      if (!codes.has(m[1])) {
        bad.push({ rel, n, line: line.trim(), why: `「${m[1]}」不在 lib/error-codes.ts 裡。` });
      }
    }
  });

  if (!exempt && !/from "@\/lib\/server\/api"/.test(src)) {
    bad.push({ rel, n: 1, line: "(整個檔案)", why: "沒有 import lib/server/api。所有 route 都要透過它回應。" });
  }
}

if (bad.length) {
  console.error("有 API 沒有走統一的回應函式庫：\n");
  for (const b of bad) console.error(`  ${b.rel}:${b.n}\n    ${b.line}\n    → ${b.why}\n`);
  console.error(`共 ${bad.length} 處。`);
  process.exit(1);
}
console.log(`✔ ${checked} 支 API 都走 lib/server/api 回應，錯誤碼都在 lib/error-codes.ts 裡（共 ${codes.size} 個）`);
