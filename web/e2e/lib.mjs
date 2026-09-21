// 共用：瀏覽器、虛擬 passkey、登入、建帳戶、KYC（含管理員核准）
import { chromium } from "playwright";

export const BASE = process.env.BASE_URL ?? "http://localhost:10010";

/// 每一次執行給一般使用者一組新的 email。
///
/// 伺服器現在記得「這個 email 綁過哪個鏈上帳戶」，並在登入時自動還原。
/// 固定 email 因此等於跨執行共用同一個帳戶：第二次跑的 alice 會帶著上一次的
/// 餘額與持倉開始，於是「領取 mTWD 之後餘額是 100,000」這種檢查就會爆掉——
/// 爆的不是功能，是測試自己留下的狀態。
/// 管理員與查驗機構不能這樣做：它們的權限是 ADMIN_EMAILS / VERIFIER_EMAILS 白名單。
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const who = (name) => `${name}-${RUN}@example.com`;

export async function launch() {
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}

/// 新的瀏覽器 context = 新的使用者（獨立 cookie 與 localStorage）+ 虛擬 authenticator
export async function newUser(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[${label} pageerror]`, e.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { context, page, label };
}

export async function waitOk(page, text, timeout = 90_000) {
  const okLoc = page.locator(`text=${text}`).first();
  const errLoc = page.locator('[data-testid="notice-error"]').first();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // 回傳整段通知文字：像「上架批次 #123」這種通知裡帶著呼叫端要的編號，
    // 讓它自己再去翻一次畫面只會多一個時間差。
    if (await okLoc.isVisible().catch(() => false)) return (await okLoc.textContent())?.trim() ?? "";
    if (await errLoc.isVisible().catch(() => false)) throw new Error(`頁面錯誤：${(await errLoc.textContent()).trim()}`);
    await page.waitForTimeout(300);
  }
  if (process.env.E2E_DEBUG) {
    await page.screenshot({ path: `/tmp/e2e-fail-${Date.now()}.png`, fullPage: true }).catch(() => {});
    console.log("[debug body]", (await page.locator("body").innerText()).slice(0, 2500));
  }
  throw new Error(`timeout waiting: ${text}`);
}

export async function login(page, email) {
  await page.goto(BASE);
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByRole("button", { name: "登入", exact: true }).click();
  await page.locator("text=登出").waitFor({ timeout: 30_000 });
}

export async function createPasskeyAccount(page) {
  const ready = page.locator('[data-testid="account-ready"]');
  // 這個 email 之前綁過帳戶的話，登入當下就已經自動還原，畫面直接是「帳戶已就緒」，
  // 根本沒有「建立」那顆按鈕可以按。e2e 重跑第二次就是這個情況（accounts.json
  // 只在 rebuild 時才清）。兩種狀態都要能往下走，否則測到的只是第一次的路徑。
  const create = page.getByRole("button", { name: /建立(新|鏈上|另一個)帳戶/ });
  await Promise.race([
    ready.waitFor({ timeout: 30_000 }),
    create.waitFor({ timeout: 30_000 }),
  ]);
  if (!(await ready.isVisible().catch(() => false))) await create.click();
  await ready.waitFor({ timeout: 60_000 });
  // 從「帳戶已就緒 · 0x…」裡取地址。原本抓的是 `dd.font-mono`，那是旁邊統計面板的
  // 第一個等寬數字——所以這個函式一直回傳「239,293噸」之類的東西，
  // 而 flow.mjs 第一行就把它印成「✔ 登入 + 帳戶 239,293噸」。沒人看出來，
  // 是因為沒有任何一個檢查真的拿它跟地址比對過。
  return /0x[0-9a-fA-F]{40}/.exec(await ready.innerText())?.[0] ?? "";
}

/// 送出 KYC 申請；tier: "individual" | "corporate"
export async function applyKyc(page, tier, idNumber, name) {
  await page.goto(`${BASE}/kyc`);
  await page.locator("select").first().selectOption(tier === "corporate" ? "2" : "1");
  await page.getByPlaceholder(tier === "corporate" ? "12345678" : "A123456789").fill(idNumber);
  await page.getByPlaceholder("王小明 / 某某股份有限公司").fill(name);
  await page.getByRole("button", { name: "驗證並綁定帳戶" }).click();
  await waitOk(page, "申請已送出");
}

/// 管理員核准所有待審 KYC
export async function adminApproveAllKyc(adminPage) {
  await adminPage.goto(`${BASE}/admin`);
  await adminPage.locator('[data-testid="kyc-row"]').first().waitFor({ timeout: 30_000 });
  for (let i = 0; i < 10; i++) {
    const rows = adminPage.locator('[data-testid="kyc-row"]');
    const before = await rows.count();
    if (before === 0) break;
    await rows.first().getByRole("button", { name: "核准", exact: true }).click();
    await waitOk(adminPage, "核准完成");
    // 「核准完成」只代表 API 回來了，清單是之後才重抓的。固定睡 300ms 不夠——
    // 慢的時候第二圈會按到同一列，伺服器回「已處理過」，測試就掛在一個
    // **測試自己造成**的錯誤上。等列數真的變少再繼續。
    await adminPage.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="kyc-row"]').length < n,
      before,
      { timeout: 30_000 },
    );
  }
}

export async function waitKycActive(page) {
  await page.goto(`${BASE}/kyc`);
  await page.locator("text=前往交易").waitFor({ timeout: 30_000 });
}

/// 勾選畫面上所有待簽的定型化契約。條文改版後會再次出現，所以每次操作前都跑一次。
/// scope 可以是 page，也可以是對話框的 locator——確認單裡也有待簽的契約。
export async function agreeAll(scope) {
  const boxes = scope.locator('[data-testid^="agree-"]');
  for (let i = 0; i < (await boxes.count()); i++) {
    const b = boxes.nth(i);
    if (await b.isVisible().catch(() => false) && !(await b.isChecked())) await b.check();
  }
}

/// 交易所式掛單簿：先在左側點一筆掛單，右側「買進」面板填數量，
/// 再在送出前的確認單上簽契約、按簽章。
/// （2026-09-20 改版：數量改以噸為單位，下單前多一張確認單。）
/// country 用核發國篩選（例如 "TW" = 只看國內專案），比對專案名字可靠：
/// 專案名是模擬器隨機生出來的，回填一整年之後書上有哪些名字每次都不一樣，
/// 用固定字串去 match 等於在賭運氣——測試掛掉的時候查半天，發現功能是好的。
export async function buyFromBook(page, { match, country, tonnes = 1 } = {}) {
  const buyTab = page.locator('[data-testid="tab-buy"]');
  if (await buyTab.isVisible().catch(() => false)) await buyTab.click();
  const limitTab = page.locator('[data-testid="mode-limit"]');
  if (await limitTab.isVisible().catch(() => false)) await limitTab.click();
  if (country) {
    const chip = page.locator(`[data-testid="filter-${country}"]`);
    await chip.waitFor({ timeout: 30_000 });
    await chip.click();
  }
  const row = match
    ? page.locator("li button", { hasText: match }).first()
    : page.locator('li button[aria-pressed]').first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  const qty = page.getByLabel(/數量（噸/);
  await qty.waitFor({ timeout: 10_000 });
  await qty.fill(String(tonnes));
  await page.locator('[data-testid="submit-buy"]').click();

  const dialog = page.getByRole("dialog", { name: "確認買進" });
  await dialog.waitFor({ timeout: 10_000 });
  await agreeAll(dialog);
  // 自然人買方要額外確認「不得申請註銷」（買賣契約第五條（五））
  const ack = dialog.locator('[data-testid="natural-ack"]');
  if (await ack.isVisible().catch(() => false)) await ack.check();
  await dialog.getByRole("button", { name: "以 passkey 簽章買進" }).click();
  await waitOk(page, `購買 ${tonnes.toLocaleString("zh-TW", { maximumFractionDigits: 3 })} 噸完成`);
}

/// 市價買進：切到市價 → 填數量 → 確認單。成交後會立刻拆解成具體批次。
export async function marketBuy(page, { tonnes = 1 } = {}) {
  await page.locator('[data-testid="tab-buy"]').click();
  await page.locator('[data-testid="mode-market"]').click();
  await page.locator('[data-testid="market-qty"]').fill(String(tonnes));
  // 等實際報價回來再送出。授權金額是**從報價算的**，不是用現貨價乘一乘——
  // 池子是曲線，成交價是沿路的平均價，薄的時候差兩成以上。
  // 沒等到報價就送出，授權會退回用現貨估，正好重現原本那個 bug。
  await page.locator('[data-testid="mbuy-cost"]').waitFor({ timeout: 15_000 });
  await page.locator('[data-testid="submit-market-buy"]').click();
  const dialog = page.getByRole("dialog", { name: "確認市價買進" });
  await dialog.waitFor({ timeout: 10_000 });
  await agreeAll(dialog);
  const ack = dialog.locator('[data-testid="natural-ack"]');
  if (await ack.isVisible().catch(() => false)) await ack.check();
  await dialog.getByRole("button", { name: "以 passkey 簽章買進" }).click();
  await waitOk(page, `市價買進 ${tonnes.toLocaleString("zh-TW", { maximumFractionDigits: 3 })} 噸完成`);
}

/// 在交易頁上架賣出：切到「賣出」分頁 → 數量與單價 →（必要時）進階設定 → 確認單。
export async function sellOnBook(page, { tonnes = 1, price, usageDeadline = "2027-12-31" } = {}) {
  await page.locator('[data-testid="tab-sell"]').click();
  const panel = page.locator('[data-testid="sell-row"]');
  await panel.waitFor({ timeout: 30_000 });
  await panel.getByLabel(/數量（噸/).fill(String(tonnes));
  if (price != null) await panel.getByLabel("單價 mTWD / 噸").fill(String(price));
  await panel.getByRole("button", { name: /進階設定/ }).click();
  await panel.getByLabel("使用期限").fill(usageDeadline);
  await page.locator('[data-testid="submit-sell"]').click();

  const dialog = page.getByRole("dialog", { name: "確認上架賣出" });
  await dialog.waitFor({ timeout: 10_000 });
  await agreeAll(dialog);
  await dialog.getByRole("button", { name: "以 passkey 簽章上架" }).click();
  const ok = await waitOk(page, "上架批次 #");
  // 回傳批次編號：買方要**指名**買這一張掛單的時候，這是唯一穩定的鍵。
  return Number(/#(\d+)/.exec(ok)?.[1]);
}

/// 註銷：在 /retire 選標的、填受益人與數量，再在確認單上簽章。
export async function retireOnPage(page, { beneficiary, tonnes = 1 } = {}) {
  await page.goto(`${BASE}/retire`);
  const qty = page.getByLabel(/數量（噸/);
  await qty.waitFor({ timeout: 30_000 });
  await qty.fill(String(tonnes));
  await page.getByPlaceholder("某某股份有限公司").fill(beneficiary);
  await agreeAll(page);
  await page.getByRole("button", { name: "註銷並取得憑證" }).click();

  const dialog = page.getByRole("dialog", { name: "確認註銷" });
  await dialog.waitFor({ timeout: 10_000 });
  await dialog.getByRole("button", { name: "以 passkey 簽章註銷" }).click();
  await waitOk(page, "註銷批次 #");
}
