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

  // 第三個量是價格，不是噸數。掛單量（掛單簿上有幾噸）隨著誰剛好在掛單而跳動，
  // 多不代表便宜、少也不代表搶手——拿六個轄區並排比較時，能回答問題的是價格。
  await page.getByRole("button", { name: "成交均價" }).click();
  await page.waitForTimeout(500);
  const priceRow = await rows.first().innerText();
  ok(/mTWD \/ 噸/.test(priceRow), `成交均價的單位是 mTWD / 噸：${priceRow.split("\n")[0]}`);
  ok(await page.getByRole("button", { name: "掛單量" }).count() === 0, "「掛單量」不再是可比較的量");

  // 走勢小圖。它是圖，但數字不能只活在圖裡——最新價、漲跌、最高最低都要是文字，
  // 而且 aria-label 要說得出這張圖畫的是誰的什麼，不然螢幕報讀器只會唸到一個 svg。
  // 前面的步驟已經選過一列，而點選是**切換**：對同一列再點一次會取消選取，
  // 明細卡就不見了。所以先看它是不是已經被選起來。
  const tw = page.getByRole("button").filter({ hasText: "臺灣" }).first();
  if ((await tw.getAttribute("aria-pressed")) !== "true") await tw.click();
  const fig = page.locator("figure").first();
  await fig.waitFor({ timeout: 10_000 });
  const figText = await fig.innerText();
  ok(/近一年走勢/.test(figText), "明細卡有價格走勢圖");
  ok(/最低[\s\S]*最高/.test(figText), "走勢圖把最高最低直接寫出來，不必 hover");
  const aria = await fig.getByRole("img").getAttribute("aria-label");
  ok(/臺灣.*走勢.*最高.*最低.*最新/.test(aria ?? ""), `走勢圖有可讀的替代文字：${aria?.slice(0, 40)}…`);

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

// ── 一個登入方式都沒有的站台 ──────────────────────────────────────
//
// 登入供應商是環境變數開的：關掉 Google、production 又沒開 AUTH_DEV_LOGIN，
// providers 就是空的。這一段擋的是那時候畫面**什麼都不說**——
// 導覽列有「登入」、內頁叫人「回首頁登入」，回到首頁那裡空一塊，按鈕看起來就是壞的。
{
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  // 只改 providers，其餘照伺服器原本回的走——這裡要測的是畫面怎麼反應，不是設定怎麼讀。
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, providers: [] } });
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  console.log("沒有任何登入方式時");
  ok(await page.locator('[data-testid="no-login"]').isVisible(), "首頁說明為什麼不能登入");
  ok(await page.locator("header").getByRole("link", { name: "登入" }).count() === 0,
    "導覽列不給一顆沒有去處的「登入」");
  await page.goto(`${BASE}/trade`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  ok(await page.locator('[data-testid="no-login"]').isVisible(), "內頁也說明，而不是叫人回首頁登入");
  ok(await page.getByRole("button", { name: "回首頁登入" }).count() === 0, "不留死路的「回首頁登入」");
  await ctx.close();
}

// ── 契約與條款：每一份都有自己的網址 ─────────────────────────────
//
// 法律文件會被引用、被存證、被貼進 email；連結點開必須就是那一份。
// 這一段同時擋住「新增一份 markdown 卻忘了掛進清單」與「舊的 ?id= 連結變 404」。
{
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/agreements`, { waitUntil: "networkidle" });
  console.log("契約與條款");

  const DOCS = [
    "platform-terms", "service-flow", "service-fee", "trade-agreement",
    "retirement-mandate", "terms-of-service", "privacy-policy",
  ];
  for (const id of DOCS) {
    ok(await page.locator(`[data-testid="doc-${id}"]`).count() === 1, `清單上有 ${id}`);
  }

  // 直接開網址就要看到全文，不能只是清單頁再靠 JS 撈——法律文件要能「另存新檔」。
  for (const id of ["privacy-policy", "terms-of-service"]) {
    const res = await page.goto(`${BASE}/agreements/${id}`, { waitUntil: "domcontentloaded" });
    const html = await res.text();
    ok(html.includes("內容雜湊"), `${id} 的條文是伺服器端就渲染好的`);
    ok(html.includes("contact@tidebit-defi.com"), `${id} 寫出聯絡窗口`);
  }

  // 舊連結不能死
  await page.goto(`${BASE}/agreements?id=service-flow`, { waitUntil: "domcontentloaded" });
  ok(page.url().endsWith("/agreements/service-flow"), "舊的 ?id= 連結會轉到新網址");

  // 頁尾：這兩份文件的慣例位置，而且每一頁都要有
  for (const path of ["/", "/trade", "/agreements/privacy-policy"]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    const foot = page.locator("footer");
    ok(await foot.getByRole("link", { name: "隱私權政策" }).count() === 1, `${path} 的頁尾有隱私權政策`);
    ok(await foot.getByRole("link", { name: "服務條款" }).count() === 1, `${path} 的頁尾有服務條款`);
  }
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
