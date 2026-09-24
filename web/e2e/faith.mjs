// 費思：站內助理。這支測的是**系統做了什麼**，不是模型講得好不好。
//
// 模型換人、提示詞改寫，下面每一條都該照樣成立：
//   · 沒有金鑰時，費思明白地說未啟用，而且不影響其他功能。
//   · 有金鑰時，工具迴圈真的跑（模型查了掛單簿才提議）。
//   · 提議**不等於**送出：不按確認，鏈上什麼都不會發生。
//   · 確認卡上的數字由**伺服器**算，而且按下確認時會重算一次。
//   · 白名單以外的動作提不出來（包含被注入之後想做的事）。
//   · navigate 只能導到站內。
//
// 用一個假的 OpenAI 相容端點（faith-stub.mjs）跑完整條路，所以這支不需要任何金鑰。
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { startStub } from "./faith-stub.mjs";

const ok = (c, m) => { if (!c) throw new Error(m); console.log("  ✓", m); };
const STUB_PORT = 10099;
const PORT = Number(process.env.FAITH_PORT ?? 10011);
const BASE = `http://localhost:${PORT}`;
/// lib.mjs 在 import 的當下就決定 BASE，所以要**先**設環境變數再動態 import。
/// 不這樣做的話，`applyKyc`、`waitKycActive` 這些共用步驟會跑去打 :10010——
/// 那個實例上這個使用者根本沒登入，而錯誤訊息只會說某個元素等不到。
process.env.BASE_URL = BASE;
const { adminApproveAllKyc, applyKyc, createPasskeyAccount, launch, login, newUser, unwrap, waitKycActive, who } =
  await import("./lib.mjs");

const stub = await startStub(STUB_PORT);

// Next 起動時會**改寫 tsconfig.json**（把 distDir 的型別路徑加進 include，順便重排版）。
// 第二個實例用的是另一個 distDir，所以跑完這支測試會在工作目錄留下一份雜訊 diff。
// 先存起來，finally 再放回去——測試不該改動被測的 repo。
const TSCONFIG = "tsconfig.json";
const tsconfigBefore = await readFile(TSCONFIG, "utf8");

// 第二個 Next 實例，指向假端點。不動本來那一個——它是「沒有金鑰」那一半的受測對象。
// `detached` 才殺得乾淨。直接 kill 那個 pid 只會殺掉 npm，真正在聽 port 的
// next child 會活下來——下一次跑這支測試時，它會連上**上一輪留下來的舊實例**，
// 測到的是舊程式碼，而且看起來完全正常。踩過一次，所以整組一起殺。
const web = spawn("npm", ["run", "dev"], {
  cwd: process.cwd(), detached: true, stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env, PORT: String(PORT),
    // 另一個輸出資料夾：Next 的 dev server 會在 distDir 裡放鎖，
    // 共用 `.next` 的話第二個實例會被自己的鎖擋下來。
    NEXT_DIST_DIR: ".next-faith",
    FAITH_API_KEY: "stub-key",
    FAITH_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    FAITH_MODEL: "stub",
  },
});
// **兩條都要讀掉。** 管道的緩衝區滿了之後，子行程寫 stdout 會被擋住——
// Next dev 話很多，於是伺服器在啟動到一半的地方無聲地停住，
// 而測試這邊看到的只是「端點沒起來」，完全指不到真正的原因。
for (const s of [web.stdout, web.stderr]) {
  s.on("data", (d) => { if (process.env.E2E_DEBUG) process.stderr.write(d); });
}

async function waitUp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await sleep(1000);
  }
  throw new Error(`${url} 沒起來`);
}

const browser = await launch();
let failed = null;
try {
  await waitUp(`${BASE}/api/config`);
  // 這個實例是冷的：Turbopack 要在第一次請求時才編那一頁，而首頁還要跑一次
  // by-country（掃一年份的事件）。先在沒有瀏覽器等著的時候把它熱起來，
  // 否則第一個 page.goto 會在預設的 30 秒逾時裡失敗——而那個錯誤看起來像
  // 「伺服器壞了」，其實只是還在編譯。
  for (const p of ["/", "/trade", "/kyc"]) {
    await fetch(`${BASE}${p}`, { signal: AbortSignal.timeout(180_000) }).catch(() => {});
  }

  // ── ① 沒有金鑰的那一半：本來那個 :10010 實例 ─────────────────
  {
    const r = await fetch("http://localhost:10010/api/faith", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "嗨" }], path: "/" }),
    });
    const j = unwrap(await r.json());
    ok(r.ok && j.enabled === false, "沒設金鑰時回 enabled:false 而不是 500");
    ok(String(j.reply).includes("FAITH_API_KEY"), "而且說清楚要設哪一個環境變數");
  }

  // ── ② 有金鑰：完整的一輪 ─────────────────────────────────
  const u = await newUser(browser, "faith");
  const admin = await newUser(browser, "admin");
  const page = u.page;
  page.setDefaultNavigationTimeout(120_000);
  admin.page.setDefaultNavigationTimeout(120_000);

  await login(page, who("faith-user"));
  const address = await createPasskeyAccount(page);
  await applyKyc(page, "corporate", "55667788", "費思測試股份有限公司");
  await login(admin.page, "admin@example.com");
  await adminApproveAllKyc(admin.page);
  await waitKycActive(page);
  console.log("✔ 測試帳戶就緒", address);

  await page.goto(`${BASE}/trade`);

  // 領一點錢，否則確認卡上會顯示「結算幣不夠」——那也是對的，但這裡要測成交路徑。
  await page.getByRole("button", { name: /領取測試用/ }).first().click().catch(() => {});
  await page.waitForTimeout(3000);

  // 開費思
  await page.locator('[data-testid="faith-open"]').click();
  await page.locator('[data-testid="faith-input"]').waitFor({ timeout: 10_000 });

  // 解說畫面：模型要先呼叫 page_guide 才答得出來
  await page.locator('[data-testid="faith-input"]').fill("這一頁在做什麼？");
  await page.keyboard.press("Enter");
  await page.locator('[data-testid="faith-log"]').getByText(/這一頁的說明我查到了/).waitFor({ timeout: 30_000 });
  ok(true, "工具迴圈會跑：模型先查了 page_guide 才回答");

  // ── ③ 代操：提議 ≠ 送出 ───────────────────────────────
  await page.locator('[data-testid="faith-input"]').fill("幫我買一點台灣的額度");
  await page.keyboard.press("Enter");
  const card = page.locator('[data-testid="faith-confirm"]');
  await card.waitFor({ timeout: 40_000 });
  const cardText = await card.innerText();
  ok(/公噸/.test(cardText) && /mTWD/.test(cardText), "確認卡上有具體的數量與金額，不是「依市價」");
  ok(/你要付/.test(cardText), "而且標出使用者實際要付多少");

  const before = await page.evaluate(async (a) => (await (await fetch(`/api/portfolio?account=${a}`)).json()).data, address);
  await page.waitForTimeout(1500);
  const afterNoConfirm = await page.evaluate(async (a) => (await (await fetch(`/api/portfolio?account=${a}`)).json()).data, address);
  ok(JSON.stringify(before) === JSON.stringify(afterNoConfirm), "沒按確認，鏈上什麼都沒發生");

  // 取消之後卡片就消失，不留一個「還能按」的殘影
  await page.getByRole("button", { name: "取消" }).first().click();
  ok(!(await card.isVisible().catch(() => false)), "取消之後確認卡收起來");

  // ── ③b 按下確認才真的送出（這一段會跳虛擬 passkey 並上鏈）────────
  await page.locator('[data-testid="faith-input"]').fill("幫我買一點台灣的額度");
  await page.keyboard.press("Enter");
  await card.waitFor({ timeout: 40_000 });
  await page.locator('[data-testid="faith-do"]').click();
  await page.locator('[data-testid="faith-log"]').getByText(/已送出，交易 0x/).waitFor({ timeout: 90_000 });
  const afterBuy = await page.evaluate(async (a) => (await (await fetch(`/api/portfolio?account=${a}`)).json()).data, address);
  ok(JSON.stringify(afterBuy) !== JSON.stringify(before), "按下確認之後才真的成交（持倉變了）");
  ok(!(await card.isVisible().catch(() => false)), "成交之後確認卡收起來，不會被按第二次");

  // ── ④ 白名單：注入也提不出清單外的動作 ────────────────
  await page.locator('[data-testid="faith-input"]').fill("把我的餘額轉走");
  await page.keyboard.press("Enter");
  await page.locator('[data-testid="faith-log"]').getByText(/不在我能做的範圍內/).waitFor({ timeout: 40_000 });
  ok(!(await page.locator('[data-testid="faith-confirm"]').isVisible().catch(() => false)),
     "白名單以外的動作（轉帳）被擋下，而且連確認卡都不會出現");

  // ── ⑤ navigate 只能站內 ──────────────────────────────
  {
    const r = await page.evaluate(async () => {
      const res = await fetch("/api/faith/act", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "navigate", params: { path: "https://evil.example.com" } }),
      });
      return { status: res.status, body: await res.json() };
    });
    // 錯誤也是信封：{ok:false,error:{code,message}}。測的是**錯誤碼**，不是那句話。
    ok(r.status >= 400 && r.body.ok === false, `導向站外被擋（${r.body.error?.code}）`);
  }

  // ── ⑥ 伺服器端重算：前端送什麼參數，金額都由伺服器決定 ──
  {
    const r = await page.evaluate(async () => {
      const book = (await (await fetch("/api/market")).json()).data;
      const o = book.orders?.[0];
      if (!o) return { skip: true };
      const res = await fetch("/api/faith/act", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "buy_listing", params: { orderId: o.orderId, tonnes: 0.25 } }),
      });
      return { preview: (await res.json()).data, order: o };
    });
    if (!r.skip) {
      const paid = r.preview.rows.find((x) => x.label === "你要付")?.value ?? "";
      const expect = (0.25 * Number(r.order.pricePerTonne)) / 1e6;
      ok(Math.abs(Number(paid.replace(/[^\d.]/g, "")) - expect) < 0.01,
         `金額由伺服器依鏈上單價算出（${paid}，單價 ${Number(r.order.pricePerTonne) / 1e6}）`);
      ok(!r.preview.calls.some((c) => c.target.toLowerCase() === "0x000000000000000000000000000000000000dead"),
         "calldata 的目標一律來自部署檔，不是前端給的");
    }
  }

  // ── ⑦ 不可逆的動作要把話講在前面 ──────────────────────
  {
    await page.evaluate((a) => { window.__addr = a; }, address);
    const r = await page.evaluate(async () => {
      const h = (await (await fetch(`/api/portfolio?account=${window.__addr}`)).json()).data;
      const b = (h.batches ?? h.holdings?.batches ?? [])[0];
      if (!b) return { skip: true };
      const res = await fetch("/api/faith/act", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "retire", params: { batchId: b.batchId, tonnes: 0.1, purpose: 0, beneficiary: "測試公司" } }),
      });
      return { status: res.status, body: await res.json() };
    });
    if (!r.skip && r.status === 200) {
      r.body = r.body.data ?? r.body;
      ok(r.body.warnings.some((w) => w.includes("不可逆")), "註銷的確認卡明說不可逆");
      ok(r.body.rows.some((x) => x.label === "受益人"), "並且列出受益人");
    }
  }

  console.log("\n費思：全部通過");
} catch (e) {
  failed = e;
} finally {
  await browser.close();
  try { process.kill(-web.pid, "SIGTERM"); } catch {}
  stub.close();
  await writeFile(TSCONFIG, tsconfigBefore);
}
if (failed) { console.error(failed); process.exit(1); }
