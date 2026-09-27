#!/usr/bin/env node
// 前端不直接跟區塊鏈說話——這支腳本負責讓這句話一直成立。
//
// 規則本身很容易在某次「先動起來再說」的修改裡被破掉：想在元件裡讀一個餘額，
// 手邊剛好有 viem，`createPublicClient({ transport: http(rpcUrl) })` 兩行就好了。
// 那兩行不會讓任何測試變紅，只會讓系統多一條沒人記得的路：瀏覽器直連節點。
//
// 為什麼這條界線值得守：
//   · 節點位址一旦發給瀏覽器就等於公開，任何人都能拿它對節點發請求。
//   · 瀏覽器連得到的節點與伺服器連得到的節點不一定是同一個（內網、IP 白名單、
//     公司防火牆），兩邊各讀一次就會各看到一條鏈，而畫面不會告訴你這件事。
//   · ABI 只留在伺服器端，合約改版時不必擔心某個使用者的瀏覽器還快取著舊的。
//
// 改用 CAFECA 之後這條界線更乾淨了：簽章不再發生在我們的頁面裡，而是在 CAFECA
// 錢包（另一個 origin）。我們這一側只負責組出「要簽什麼」，而那份 EIP-712 結構
// 由前後端共用的 lib/bank/order-typed.ts 產生——它是純雜湊，不碰網路。
//
// 目前的節點是 http:// 的（沒有 TLS）。站台走 HTTPS 時瀏覽器根本呼叫不到它
// （mixed content），所以違反這條界線的程式碼會在正式環境直接壞掉，
// 而在 localhost 開發時看起來一切正常——這正是要用腳本擋、不能靠自律的理由。

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/// 掃哪裡。真正的判準不是資料夾，是**這個檔案會不會被打包進瀏覽器**：
/// 標了 "use client" 的檔案會，lib/client/** 依慣例也會。
/// 沒標的 app/** 是 server component（例如 /agreements 那兩頁），它在伺服器上跑，
/// import 伺服器端模組是對的，不該被這支腳本罵。
const SCAN_DIRS = ["app", "components", "lib/client"];
const shipsToBrowser = (rel, src) =>
  rel.startsWith("lib/client/") || /^\s*["']use client["']/m.test(src);

const RULES = [
  { re: /createPublicClient|createWalletClient/, why: "在瀏覽器裡開 RPC 連線。改成呼叫 /api/*，由後端讀鏈。" },
  { re: /\bhttp\(\s*[A-Za-z_$][\w.$]*\s*\)/, why: "viem 的 http() transport 指向節點。鏈上讀寫請走 /api/*。" },
  { re: /\brpcUrl\b/, why: "RPC 位址不該出現在前端。/api/config 已經不再回傳它。" },
  // NEXT_PUBLIC_ 開頭的環境變數會被**原封不動編進 bundle**。名字裡有 RPC / NODE
  // 的那些等於把節點位址印在每一個訪客的瀏覽器裡。
  { re: /NEXT_PUBLIC_\w*(RPC|NODE_URL|CHAIN_URL)/i, why: "NEXT_PUBLIC_ 的值會編進 bundle，節點位址不能這樣發。" },
  // 寫死的節點位址。抓 :8545 / :8546 這類節點慣用埠，以及裸 IP 加埠。
  { re: /:\s*8545|:\s*8546|\bhttps?:\/\/\d+\.\d+\.\d+\.\d+:\d+/, why: "前端不該知道節點在哪裡。鏈上讀寫走 /api/*。" },
  // `import type` 在編譯時就被抹掉，不會把伺服器端程式帶進 bundle，
  // 而且共用型別正是應該共用的東西——只擋真的會帶進去的那種。
  { re: /^(?!.*\bimport\s+type\b).*from\s+["']@\/lib\/server\//, why: "前端不要 import 伺服器端模組（型別用 import type）。" },
];

function* walk(dir) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") yield* walk(rel); }
    else if (/\.tsx?$/.test(e.name)) yield rel;
  }
}

const bad = [];
for (const dir of SCAN_DIRS) {
  if (!fs.existsSync(path.join(ROOT, dir))) continue;
  for (const rel of walk(dir)) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    if (!shipsToBrowser(rel, src)) continue;
    src.split(/\r?\n/).forEach((line, i) => {
      // 註解裡提到這些字是在解釋規則本身，不算違規
      if (/^\s*(\/\/|\/\*|\*|\/\/\/)/.test(line)) return;
      for (const r of RULES) if (r.re.test(line)) bad.push({ rel, n: i + 1, line: line.trim(), why: r.why });
    });
  }
}

// ── 另一半：API 的回應不能把節點位址送出去 ──────────────────────
//
// 上面掃的是「瀏覽器裡有沒有直連節點的程式碼」。但還有一條更安靜的路：
// 某支 API 順手把 RPC_URL 放進回應，前端不必寫任何連線程式碼就拿到了節點位址。
// /api/config 曾經就是這樣（見那支檔案的註解）。
const API_DIR = "app/api";
if (fs.existsSync(path.join(ROOT, API_DIR))) {
  for (const rel of walk(API_DIR)) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    src.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\/\*|\*|\/\/\/)/.test(line)) return;
      // 只在「回應」的上下文裡算違規：ok(...) / NextResponse.json(...) 這一行帶了 RPC_URL。
      if (/\b(ok|json)\s*\(/.test(line) && /\bRPC_URL\b|\brpcUrl\b/.test(line)) {
        bad.push({ rel, n: i + 1, line: line.trim(), why: "API 的回應不能帶節點位址——前端不需要知道它。" });
      }
    });
  }
}

if (bad.length) {
  console.error("前端直接碰到區塊鏈了：\n");
  for (const b of bad) console.error(`  ${b.rel}:${b.n}\n    ${b.line}\n    → ${b.why}\n`);
  console.error(`共 ${bad.length} 處。鏈上讀寫請加一支 /api/… 端點，由伺服器端的 publicClient 執行。`);
  process.exit(1);
}
console.log(`✔ 前端沒有直接連節點（掃過 ${SCAN_DIRS.join("、")} 會進瀏覽器的檔案，以及 ${API_DIR} 的回應）`);
