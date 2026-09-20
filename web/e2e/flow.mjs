// 自然人流程：登入 → passkey 建帳戶 → KYC 申請 → 管理員核准 → faucet → 掛單買 → v4 買 → 註銷 → 憑證 → 管理員產生 PDF 並回寫
// 前置：anvil 已跑 DemoFlow、next 在 :3000（KYC_AUTO_APPROVE=0）。執行：node e2e/flow.mjs
import { BASE, adminApproveAllKyc, agreeAll, applyKyc, buyFromBook, createPasskeyAccount, launch, login, newUser, waitKycActive, waitOk } from "./lib.mjs";

const browser = await launch();
const alice = await newUser(browser, "alice");
const admin = await newUser(browser, "admin");

await login(alice.page, "alice@example.com");
const address = await createPasskeyAccount(alice.page);
console.log("✔ 登入 + 帳戶", address);

await applyKyc(alice.page, "individual", "A123456789", "Alice Chen");
await alice.page.locator('[data-testid="kyc-application"]', { hasText: "審核中" }).waitFor();
console.log("✔ KYC 申請（審核中）");

await login(admin.page, "admin@example.com");
await adminApproveAllKyc(admin.page);
await waitKycActive(alice.page);
console.log("✔ 管理員核准 KYC");

const page = alice.page;
await page.goto(`${BASE}/trade`);
await page.getByRole("button", { name: "領取測試用 mTWD" }).click();
await page.locator('[data-testid="twd"]', { hasText: "100,000" }).waitFor({ timeout: 30_000 });
await buyFromBook(page, { tonnes: 1 });
await agreeAll(page);
await page.getByRole("button", { name: "以 passkey 簽章購買" }).click();
await waitOk(page, "流動性池購買（2000 mTWD）完成");
console.log("✔ 掛單 + v4 購買");

await page.getByPlaceholder("某某股份有限公司").fill("Alice Chen");
await agreeAll(page); // 註銷需先簽註銷暨移轉委任書
// 別寫死批次編號。掛單簿按價格排序，只要鏈上多了一筆更便宜的掛單（例如先跑過
// enterprise.mjs），買到的就不是批次 #1，測試會在這裡假性失敗。
const bought = (await page.locator('[data-testid="batches"]').innerText()).match(/#(\d+)/)[1];
await page.getByRole("button", { name: "註銷", exact: true }).first().click();
await waitOk(page, `註銷批次 #${bought} 1 噸完成`);
await page.getByRole("button", { name: "註銷", exact: true }).first().click();
await waitOk(page, "註銷池化額度");
await page.goto(`${BASE}/certificates`);
await page.locator("text=憑證 #").first().waitFor({ timeout: 30_000 });
const n = await page.locator("text=憑證 #").count();
console.log("✔ 憑證數量", n);

// 管理員：產生 PDF → 回寫鏈上
await admin.page.goto(`${BASE}/admin`);
await admin.page.getByRole("button", { name: "憑證文件" }).click();
await admin.page.locator('[data-testid="cert-row"]').first().waitFor({ timeout: 30_000 });
await admin.page.locator('[data-testid="cert-row"]').first().getByRole("button", { name: "產生 PDF" }).click();
await waitOk(admin.page, "產生 PDF #");
await admin.page.locator('[data-testid="cert-row"]').first().getByRole("button", { name: "回寫鏈上" }).click();
await waitOk(admin.page, "回寫 #");
console.log("✔ 憑證 PDF 產生 + 回寫");

await page.goto(`${BASE}/certificates`);
await page.locator("text=下載 PDF").first().waitFor({ timeout: 30_000 });
const firstTitle = (await page.locator("text=憑證 #").first().textContent()).trim();
const certId = Number(firstTitle.replace(/\D/g, ""));
const pdfRes = await page.request.get(`${BASE}/api/certificates/${certId}/pdf`);
if (pdfRes.status() !== 200) throw new Error(`PDF 下載失敗 ${pdfRes.status()}`);
console.log("✔ 使用者可下載 PDF，SHA-256", pdfRes.headers()["x-sha256"]);

await browser.close();
if (n < 2) { console.error("expected ≥2 certificates"); process.exit(1); }
console.log("E2E OK");
