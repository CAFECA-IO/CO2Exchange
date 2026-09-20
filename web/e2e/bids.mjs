// 買單的完整生命週期：掛出 → 出現在簿子上 → 有人賣給它 → 取消退款。
//
// 買單這一側跟賣單是對稱的，但有一個賣單沒有的風險：**錢鎖在合約裡**。
// 所以取消退款這一段一定要測——沒有那顆按鈕，使用者的錢就拿不回來。
import {
  BASE, adminApproveAllKyc, agreeAll, applyKyc, buyFromBook, createPasskeyAccount,
  launch, login, newUser, waitKycActive, waitOk,
} from "./lib.mjs";

const ok = (c, m) => { if (!c) throw new Error(m); console.log("  ✓", m); };
const browser = await launch();

// 買方（掛買單）與賣方（手上有貨，賣給買單）
const buyer = await newUser(browser, "buyer");
const seller = await newUser(browser, "seller");
const admin = await newUser(browser, "admin");

await login(buyer.page, "bidbuyer@example.com");
await createPasskeyAccount(buyer.page);
await applyKyc(buyer.page, "corporate", "11111111", "出價股份有限公司");

await login(seller.page, "bidseller@example.com");
await createPasskeyAccount(seller.page);
await applyKyc(seller.page, "corporate", "22222222", "供貨股份有限公司");

await login(admin.page, "admin@example.com");
await adminApproveAllKyc(admin.page);
await waitKycActive(buyer.page);
await waitKycActive(seller.page);
console.log("✔ 兩個法人帳戶就緒");

// 賣方先從簿子上買一點貨，才有東西可以賣給買單
await seller.page.goto(`${BASE}/trade`);
await seller.page.getByRole("button", { name: "領取測試用 mTWD" }).click();
await seller.page.locator('[data-testid="twd"]', { hasText: "100,000" }).waitFor({ timeout: 30_000 });
await buyFromBook(seller.page, { tonnes: 3 });
console.log("✔ 賣方手上有貨了");

// ── 掛買單 ────────────────────────────────────────────────
await buyer.page.goto(`${BASE}/trade`);
await buyer.page.getByRole("button", { name: "領取測試用 mTWD" }).click();
await buyer.page.locator('[data-testid="twd"]', { hasText: "100,000" }).waitFor({ timeout: 30_000 });
await buyer.page.locator('[data-testid="tab-buy"]').click();
await buyer.page.locator('[data-testid="mode-limit"]').click();
const form = buyer.page.locator('[data-testid="place-bid-form"]');
await form.waitFor({ timeout: 10_000 });
await buyer.page.locator('[data-testid="bid-country"]').selectOption("TW");
await buyer.page.locator('[data-testid="bid-tonnes"]').fill("2");
await buyer.page.locator('[data-testid="bid-price"]').fill("1234");
const cashBefore = (await buyer.page.locator('[data-testid="twd"]').innerText()).trim();
await buyer.page.locator('[data-testid="submit-bid"]').click();
await waitOk(buyer.page, "掛買單");
console.log("✔ 掛出買單");

// 餘額是**非同步**重抓的，成功通知出現的那一刻還不一定更新。等它真的變。
await buyer.page.locator('[data-testid="twd"]').filter({ hasNotText: cashBefore }).waitFor({ timeout: 30_000 });
const cashAfter = (await buyer.page.locator('[data-testid="twd"]').innerText()).trim();
ok(cashBefore !== cashAfter, `錢當場鎖進合約（${cashBefore} → ${cashAfter}）`);

// ── 出現在簿子上，賣方看得到 ────────────────────────────────
await seller.page.reload();
await seller.page.locator('[data-testid="bid-book"]').waitFor({ timeout: 20_000 });
const bookText = await seller.page.locator('[data-testid="bid-book"]').innerText();
ok(/1,234/.test(bookText), "賣方在掛單簿的買單區看得到這張單");

// ── 賣給這張買單 ────────────────────────────────────────────
const row = seller.page.locator('[data-testid="bid-book"] button').filter({ hasText: "1,234" }).first();
await row.click();
const fill = seller.page.locator('[data-testid="fill-bid"]');
await fill.waitFor({ timeout: 10_000 });
await seller.page.locator('input[type=number]').first().fill("1");
await agreeAll(seller.page).catch(() => {});
await seller.page.locator('[data-testid="submit-fill-bid"]').click();
await waitOk(seller.page, "賣給買單");
console.log("✔ 賣方成交給買單");

// ── 取消，退回剩下的錢 ──────────────────────────────────────
await buyer.page.reload();
await buyer.page.waitForTimeout(1500);
const cancel = buyer.page.locator('[data-testid^="cancel-bid-"]').first();
await cancel.waitFor({ timeout: 20_000 });
const beforeCancel = (await buyer.page.locator('[data-testid="twd"]').innerText()).trim();
await cancel.click();
await waitOk(buyer.page, "取消買單");
await buyer.page.locator('[data-testid="twd"]').filter({ hasNotText: beforeCancel }).waitFor({ timeout: 30_000 });
const afterCancel = (await buyer.page.locator('[data-testid="twd"]').innerText()).trim();
ok(beforeCancel !== afterCancel, `取消之後剩餘的錢退回來（${beforeCancel} → ${afterCancel}）`);

// 買到的貨應該在買方手上
const batches = await buyer.page.locator('[data-testid="batches"]').innerText();
ok(/#\d+/.test(batches), `買方收到額度：${batches.trim()}`);

await browser.close();
console.log("\n買單：全部通過");
