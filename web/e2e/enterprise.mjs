// 企業流程：法人 KYC → 登錄專案 → 上傳查驗報告申請核發 → 查驗機構簽章核發 → 掛單 + 入池 → 自然人從新掛單購買
// 執行：node e2e/enterprise.mjs（需先跑過 flow.mjs 或至少有 admin 可核准）
import fs from "node:fs";
import { BASE, adminApproveAllKyc, agreeAll, applyKyc, buyFromBook, createPasskeyAccount, launch, login, newUser, waitKycActive, waitOk } from "./lib.mjs";

const browser = await launch();
const corp = await newUser(browser, "corp");
const verifier = await newUser(browser, "verifier");
const admin = await newUser(browser, "admin");
const bob = await newUser(browser, "bob");

await login(corp.page, "greenco@example.com");
const corpAddr = await createPasskeyAccount(corp.page);
await applyKyc(corp.page, "corporate", "24681357", "綠能股份有限公司");
await login(admin.page, "admin@example.com");
await adminApproveAllKyc(admin.page);
await waitKycActive(corp.page);
console.log("✔ 法人 KYC", corpAddr);

// 專案登錄
await corp.page.goto(`${BASE}/enterprise`);
await corp.page.getByPlaceholder("屋頂太陽能替代柴油發電").fill("廠區鍋爐燃料轉換");
await corp.page.getByPlaceholder("Taoyuan, TW").fill("Kaohsiung, TW");
await corp.page.getByRole("button", { name: "以 passkey 簽章登錄" }).click();
await waitOk(corp.page, "登錄專案「廠區鍋爐燃料轉換」完成");
console.log("✔ 專案登錄");

// 上傳報告申請核發
const pdfPath = "/tmp/e2e-report.pdf";
fs.writeFileSync(pdfPath, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
await corp.page.locator("select").first().selectOption({ index: 1 });
await corp.page.getByLabel("申請噸數（tCO₂e）").fill("50");
await corp.page.locator('[data-testid="report-file"]').setInputFiles(pdfPath);
await corp.page.getByRole("button", { name: "送出申請" }).click();
await waitOk(corp.page, "核發申請已送出");
await corp.page.locator('[data-testid="issuance-row"]', { hasText: "待查驗" }).waitFor();
console.log("✔ 核發申請");

// 查驗機構核發
await login(verifier.page, "verifier@example.com");
await verifier.page.goto(`${BASE}/verifier`);
await verifier.page.locator('[data-testid="verifier-row"]').first().waitFor({ timeout: 30_000 });
await verifier.page.locator('[data-testid="verifier-row"]').first().getByRole("button", { name: "簽章並核發" }).click();
await waitOk(verifier.page, "已簽章核發");
console.log("✔ 查驗機構核發");

// 企業：掛單 20 噸、入池 30 噸
await corp.page.goto(`${BASE}/enterprise`);
await corp.page.locator('[data-testid="holding-row"]', { hasText: "50 噸" }).waitFor({ timeout: 30_000 });
const row = corp.page.locator('[data-testid="holding-row"]').first();
await row.getByLabel("掛單（噸）").fill("20");
await row.getByLabel("使用期限").fill("2027-12-31");
await agreeAll(corp.page); // 上架前要簽代辦費用與減免約定書
await row.getByRole("button", { name: "掛單" }).click();
await waitOk(corp.page, "掛單批次 #");
await corp.page.locator('[data-testid="holding-row"]', { hasText: "30 噸" }).waitFor({ timeout: 30_000 });
await corp.page.locator('[data-testid="holding-row"]').first().getByLabel("入池 kg").fill("30000");
await corp.page.locator('[data-testid="holding-row"]').first().getByRole("button", { name: "入池換 CCT" }).click();
await waitOk(corp.page, "入池批次 #");
await corp.page.locator("text=掛單 #").first().waitFor();
console.log("✔ 掛單 + 入池");

// 自然人 bob 從新掛單購買並註銷
await login(bob.page, "bob@example.com");
await createPasskeyAccount(bob.page);
await applyKyc(bob.page, "individual", "B123456789", "Bob Lin");
await adminApproveAllKyc(admin.page);
await waitKycActive(bob.page);
await bob.page.goto(`${BASE}/trade`);
await bob.page.getByRole("button", { name: "領取測試用 mTWD" }).click();
await bob.page.locator('[data-testid="twd"]', { hasText: "100,000" }).waitFor({ timeout: 30_000 });
await buyFromBook(bob.page, { match: "廠區鍋爐燃料轉換", tonnes: 1 });
await bob.page.getByPlaceholder("某某股份有限公司").fill("Bob Lin");
await agreeAll(bob.page);
await bob.page.getByRole("button", { name: "註銷", exact: true }).first().click();
await waitOk(bob.page, "註銷批次 #");
console.log("✔ 自然人購買企業新掛單並註銷");

await browser.close();
console.log("ENTERPRISE E2E OK");
