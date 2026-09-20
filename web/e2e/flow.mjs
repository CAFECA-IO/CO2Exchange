// 自然人 → 法人的完整路徑：
//   自然人：登入 → passkey → KYC → faucet → 掛單買 + v4 買 → 被擋下註銷 → 轉售上架
//   法人  ：KYC → 買下自然人的掛單 → 註銷 → 憑證 → 管理員產生 PDF 並回寫 → 下載
// 自然人在官方制度裡開不了額度帳戶，所以只能買賣、不能註銷；最後用掉的一定是事業。
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

// 自然人不能註銷：介面要講清楚，而不是給一顆按了會失敗的按鈕
await page.locator("text=自然人無法註銷額度").first().waitFor({ timeout: 30_000 });
const retireDisabled = await page.getByRole("button", { name: "註銷", exact: true }).first().isDisabled();
if (!retireDisabled) throw new Error("自然人的註銷按鈕應該是停用的");
console.log("✔ 自然人被擋下註銷，且畫面有說明");

// 自然人的出場方式是轉售：在交易頁上架
const sellRow = page.locator('[data-testid="sell-row"]').first();
await sellRow.waitFor({ timeout: 30_000 });
await sellRow.getByLabel("數量（噸）").fill("1");
await sellRow.getByLabel("單價 mTWD / 噸").fill("900");
await sellRow.getByLabel("使用期限").fill("2027-12-31");
await agreeAll(page);
await sellRow.getByRole("button", { name: "上架" }).click();
await waitOk(page, "上架批次 #");
console.log("✔ 自然人轉售上架");

// 法人買下自然人的掛單並註銷——官方端只有事業能做這件事
const corp = await newUser(browser, "corp");
await login(corp.page, "corp-buyer@example.com");
await createPasskeyAccount(corp.page);
await applyKyc(corp.page, "corporate", "12345678", "買方股份有限公司");
await adminApproveAllKyc(admin.page);
await waitKycActive(corp.page);
await corp.page.goto(`${BASE}/trade`);
await corp.page.getByRole("button", { name: "領取測試用 mTWD" }).click();
await corp.page.locator('[data-testid="twd"]', { hasText: "100,000" }).waitFor({ timeout: 30_000 });
await buyFromBook(corp.page, { tonnes: 1 });
console.log("✔ 法人買下自然人的掛單");

await corp.page.getByPlaceholder("某某股份有限公司").fill("買方股份有限公司");
await agreeAll(corp.page); // 註銷需先簽註銷暨移轉委任書
const bought = (await corp.page.locator('[data-testid="batches"]').innerText()).match(/#(\d+)/)[1];
await corp.page.getByRole("button", { name: "註銷", exact: true }).first().click();
await waitOk(corp.page, `註銷批次 #${bought} 1 噸完成`);
await corp.page.goto(`${BASE}/certificates`);
await corp.page.locator("text=憑證 #").first().waitFor({ timeout: 30_000 });
const n = await corp.page.locator("text=憑證 #").count();
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

await corp.page.goto(`${BASE}/certificates`);
await corp.page.locator("text=下載 PDF").first().waitFor({ timeout: 30_000 });
const firstTitle = (await corp.page.locator("text=憑證 #").first().textContent()).trim();
const certId = Number(firstTitle.replace(/\D/g, ""));
const pdfRes = await corp.page.request.get(`${BASE}/api/certificates/${certId}/pdf`);
if (pdfRes.status() !== 200) throw new Error(`PDF 下載失敗 ${pdfRes.status()}`);
console.log("✔ 使用者可下載 PDF，SHA-256", pdfRes.headers()["x-sha256"]);

await browser.close();
if (n < 1) { console.error("expected ≥1 certificate"); process.exit(1); }
console.log("E2E OK");
