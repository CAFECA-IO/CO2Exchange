// 首頁的地球與各轄區清單：資料、互動、可近用性，以及 /about 的內容有沒有搬齊。
import { launch, BASE } from "./lib.mjs";

const ok = (c, m) => { if (!c) throw new Error(m); console.log("  ✓", m); };

const browser = await launch();

// ── 首頁 ──────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  console.log("首頁");
  ok(await page.locator("canvas").isVisible(), "地球畫布有畫出來");

  // 清單是精確的那一份，也是鍵盤與螢幕報讀器的路徑：每一國都要是真的按鈕
  const rows = page.locator('ul li button[aria-pressed]');
  const n = await rows.count();
  ok(n >= 6, `清單有 ${n} 個轄區，每一個都是按鈕`);
  ok(await page.locator("canvas[aria-hidden]").count() === 1, "畫布對輔助技術隱藏（資料走清單）");

  // 臺灣要排第一（核發量最大），而且數字不是零
  const first = rows.first();
  const txt = await first.innerText();
  ok(/臺灣/.test(txt), `核發量排序第一是臺灣：${txt.split("\n")[0]}`);
  ok(/[1-9][\d,]*/.test(txt), "數字有讀到鏈上資料，不是空的");

  // 點一國 → 出現明細
  await first.click();
  await page.waitForTimeout(600);
  ok(await first.getAttribute("aria-pressed") === "true", "選取狀態有回饋給輔助技術");
  const detail = page.locator("text=累計核發").first();
  ok(await detail.isVisible(), "點選後出現該轄區的明細");
  ok(await page.locator("text=鏈上流通").isVisible(), "明細含鏈上流通量");

  // 換一個量 → 排序跟著換
  await page.getByRole("button", { name: "交易量" }).click();
  await page.waitForTimeout(500);
  const firstAfter = await rows.first().innerText();
  ok(/噸/.test(firstAfter), `切到交易量後仍有數字：${firstAfter.split("\n")[0]}`);

  // 一次只有一個量被選起來
  const pressed = await page.locator('[role=group] button[aria-pressed=true]').count();
  ok(pressed === 1, "三個量一次只選一個（一張圖只有一把尺）");

  ok(errs.length === 0, `沒有 console 例外${errs.length ? "：" + errs[0] : ""}`);
  await ctx.close();
}

// ── 減少動態 ──────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const shot = async () => (await page.locator("canvas").screenshot()).toString("base64");
  const a = await shot();
  await page.waitForTimeout(1800);
  const b = await shot();
  console.log("減少動態");
  ok(a === b, "prefers-reduced-motion 下地球不自轉");
  await ctx.close();
}

// ── 手機 ──────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  console.log("手機");
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  ok(w <= 390, `沒有水平捲動（scrollWidth ${w}）`);
  ok(await page.locator("canvas").isVisible(), "地球在手機上也畫得出來");

  // 登入原本只有首頁 hero 裡那一個入口。手機上導覽列一換行，hero 就在兩個
  // 捲動之外，從任何內頁都回不去——「找不到登入」就是這樣來的。
  // 未登入時導覽列要有常駐入口，而且要能從內頁按到首頁的登入區。
  await page.goto(`${BASE}/trade`, { waitUntil: "networkidle" });
  const loginLink = page.locator("header").getByRole("link", { name: "登入" });
  ok(await loginLink.count() === 1, "手機版導覽列有「登入」");
  await loginLink.click();
  await page.waitForURL("**/#login");
  ok(await page.locator("#login").isVisible(), "按下去會落在首頁的登入區");
  await ctx.close();
}

// ── /about：說明與圖表都搬過去了 ─────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/about`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  console.log("/about");
  for (const id of ["project", "paris", "iso", "lifecycle", "local", "markets", "use"]) {
    ok(await page.locator(`#${id}`).count() === 1, `#${id} 章節在介紹頁`);
  }
  ok(await page.locator("text=減量額度成交價").count() > 0, "K 線行情搬到介紹頁");
  ok(await page.getByRole("link", { name: "認識碳權" }).count() > 0, "導覽列有「認識碳權」");
  await ctx.close();
}

await browser.close();
console.log("\n地球與介紹頁：全部通過");
