// 端到端：Chromium 虛擬 authenticator 模擬 passkey，走完 登入 → 建帳戶 → KYC → 購買 → 註銷 → 憑證。
// 前置：anvil 已跑 DemoFlow、next start 在 :3000。  執行：node e2e/flow.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text()); });

const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

const ok = async (label) => { await page.getByRole("status").or(page.locator("text=完成")).first().waitFor({ timeout: 60_000 }).catch(() => {}); console.log("✔", label); };
const waitOk = async (text) => {
  const okLoc = page.locator(`text=${text}`).first();
  const errLoc = page.locator('[data-testid="notice-error"]').first();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await okLoc.isVisible().catch(() => false)) return;
    if (await errLoc.isVisible().catch(() => false)) throw new Error(`頁面錯誤：${(await errLoc.textContent()).trim()}`);
    await page.waitForTimeout(300);
  }
  throw new Error(`timeout waiting: ${text}`);
};

// 1. 登入
await page.goto(BASE);
await page.getByPlaceholder("you@example.com").fill("alice@example.com");
await page.getByRole("button", { name: "登入" }).click();
await page.getByRole("button", { name: /建立新帳戶/ }).waitFor({ timeout: 30_000 });
console.log("✔ 登入");

// 2. passkey 建帳戶
await page.getByRole("button", { name: /建立新帳戶/ }).click();
await page.locator("text=帳戶已就緒").waitFor({ timeout: 60_000 });
const address = (await page.locator("dd.font-mono").first().textContent()).trim();
console.log("✔ 帳戶", address);

// 3. KYC
await page.goto(`${BASE}/kyc`);
await page.getByPlaceholder("A123456789").fill("A123456789");
await page.getByPlaceholder("王小明 / 某某股份有限公司").fill("Alice Chen");
await page.getByRole("button", { name: "驗證並綁定帳戶" }).click();
await waitOk("身分已綁定帳戶");
await page.locator("text=前往購買與註銷").waitFor({ timeout: 30_000 });
console.log("✔ KYC");

// 4. 購買
await page.goto(`${BASE}/trade`);
await page.getByRole("button", { name: "領取測試用 mTWD" }).click();
await page.locator('[data-testid="twd"]', { hasText: "100,000" }).waitFor({ timeout: 30_000 });
console.log("✔ faucet");

await page.getByRole("button", { name: "購買", exact: true }).first().click();
await waitOk("掛單購買 1 噸完成");
await page.locator('[data-testid="batches"]', { hasText: "1 噸" }).waitFor({ timeout: 30_000 });
console.log("✔ 掛單購買");

await page.getByRole("button", { name: "以 passkey 簽章購買" }).click();
await waitOk("流動性池購買（2000 mTWD）完成");
await page.locator('[data-testid="cct"]').filter({ hasNotText: "0 噸" }).waitFor({ timeout: 30_000 });
const cct = await page.locator('[data-testid="cct"]').textContent();
console.log("✔ v4 購買", cct.trim());

// 5. 註銷
await page.getByPlaceholder("某某股份有限公司").fill("Alice Chen");
await page.getByRole("button", { name: "註銷", exact: true }).first().click();
await waitOk("註銷批次 #1 1 噸完成");
console.log("✔ 註銷批次");
await page.getByRole("button", { name: "註銷", exact: true }).first().click();
await waitOk("註銷池化額度");
console.log("✔ 註銷 CCT");

// 6. 憑證
await page.goto(`${BASE}/certificates`);
await page.locator("text=憑證 #").first().waitFor({ timeout: 30_000 });
const n = await page.locator("text=憑證 #").count();
console.log("✔ 憑證數量", n);
await page.screenshot({ path: "e2e/certificates.png", fullPage: true });
await page.goto(`${BASE}/trade`);
await page.waitForTimeout(1500);
await page.screenshot({ path: "e2e/trade.png", fullPage: true });
await browser.close();
if (n < 2) { console.error("expected ≥2 certificates"); process.exit(1); }
console.log("E2E OK");
