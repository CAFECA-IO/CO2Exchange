// 共用：瀏覽器、虛擬 passkey、登入、建帳戶、KYC（含管理員核准）
import { chromium } from "playwright";

export const BASE = process.env.BASE_URL ?? "http://localhost:3000";

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
    if (await okLoc.isVisible().catch(() => false)) return;
    if (await errLoc.isVisible().catch(() => false)) throw new Error(`頁面錯誤：${(await errLoc.textContent()).trim()}`);
    await page.waitForTimeout(300);
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
  await page.getByRole("button", { name: /建立新帳戶/ }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: /建立新帳戶/ }).click();
  await page.locator("text=帳戶已就緒").waitFor({ timeout: 60_000 });
  return (await page.locator("dd.font-mono").first().textContent()).trim();
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
    if ((await rows.count()) === 0) break;
    await rows.first().getByRole("button", { name: "核准", exact: true }).click();
    await waitOk(adminPage, "核准完成");
    await adminPage.waitForTimeout(300);
  }
}

export async function waitKycActive(page) {
  await page.goto(`${BASE}/kyc`);
  await page.locator("text=前往購買與註銷").waitFor({ timeout: 30_000 });
}
