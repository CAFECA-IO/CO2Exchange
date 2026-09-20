// 截圖：深色 / 淺色各一輪，涵蓋首頁、交易、我的資產、註銷。非測試，純人工檢查用。
import { BASE, adminApproveAllKyc, applyKyc, buyFromBook, createPasskeyAccount, launch, login, newUser, waitKycActive } from "./lib.mjs";

const OUT = process.env.SHOT_DIR ?? "/tmp/shots";
const browser = await launch();
const u = await newUser(browser, "shot");
const admin = await newUser(browser, "admin");

await login(u.page, `shot-${Date.now()}@example.com`);
await createPasskeyAccount(u.page);
await applyKyc(u.page, "corporate", "11223344", "截圖股份有限公司");
await login(admin.page, "admin@example.com");
await adminApproveAllKyc(admin.page);
await waitKycActive(u.page);

await u.page.goto(`${BASE}/trade`);
await u.page.getByRole("button", { name: "領取測試用 mTWD" }).click();
await u.page.locator('[data-testid="twd"]', { hasText: "100,000" }).waitFor({ timeout: 30_000 });
await buyFromBook(u.page, { tonnes: 2 });

for (const theme of ["dark", "light"]) {
  await u.page.evaluate((t) => { localStorage.setItem("co2x.theme", t); }, theme);
  for (const [path, name] of [["/", "home"], ["/trade", "trade"], ["/portfolio", "portfolio"], ["/retire", "retire"], ["/custody", "custody"], ["/registry", "registry"]]) {
    await u.page.goto(`${BASE}${path}`);
    await u.page.waitForTimeout(2500);
    await u.page.screenshot({ path: `${OUT}/${name}-${theme}.png`, fullPage: true });
  }
}
await browser.close();
console.log("SHOTS OK");
