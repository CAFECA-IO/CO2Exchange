// 自然人 → 法人的完整路徑：
//   自然人：登入 → passkey → KYC → faucet → 掛單買 + v4 買 → 被擋下註銷 → 轉售上架
//   法人  ：KYC → 買下自然人的掛單 → 註銷 → 憑證 → 管理員產生 PDF 並回寫 → 下載
// 自然人在官方制度裡開不了額度帳戶，所以只能買賣、不能註銷；最後用掉的一定是事業。
// 前置：anvil 已跑 DemoFlow、next 在 :10010（KYC_AUTO_APPROVE=0）。執行：node e2e/flow.mjs
import {
  BASE, adminApproveAllKyc, applyKyc, buyFromBook, createPasskeyAccount, launch, login, marketBuy, newUser, retireOnPage, sellOnBook, waitKycActive, waitOk, who,
} from "./lib.mjs";

const browser = await launch();
const alice = await newUser(browser, "alice");
const admin = await newUser(browser, "admin");

await login(alice.page, who("alice"));
const address = await createPasskeyAccount(alice.page);
console.log("✔ 登入 + 帳戶", address);

// 還沒驗證身分就去交易頁，畫面要說「去辦身分驗證」，不是說「流動性不足」。
//
// 這裡擋的是一個真的發生過的誤診：v4 hook 的 beforeSwap 對未驗證帳戶 revert，
// 而報價端把**所有**失敗都當成池子沒貨。使用者輸入 1 噸（池子裡還有三十幾噸），
// 被告知「這個數量吃不下」，於是把數量改小、再失敗——永遠走不到身分驗證那一步。
{
  await alice.page.goto(`${BASE}/trade`);
  await alice.page.locator('[data-testid="need-kyc"]').waitFor({ timeout: 30_000 });
  const text = await alice.page.locator("main").innerText();
  if (!text.includes("身分驗證")) throw new Error("未驗證時交易頁沒有指向身分驗證");
  if (text.includes("流動性不足")) throw new Error("未驗證卻說流動性不足——診斷錯了，指引就會錯");
  console.log("✔ 未驗證時交易頁說的是身分驗證，不是流動性");
}

await applyKyc(alice.page, "individual", "A123456789", "Alice Chen");
await alice.page.locator('[data-testid="kyc-application"]', { hasText: "審核中" }).waitFor();
console.log("✔ KYC 申請（審核中）");

await login(admin.page, "admin@example.com");
await adminApproveAllKyc(admin.page);

// 走**使用者真正的路徑**：不重新載入頁面。停在 /kyc、按「重新整理」，
// 再點連結過去（client-side navigation）。
//
// 這件事測起來很囉嗦但非做不可：`page.goto()` 會整頁重載，把 AccountProvider
// 連同它的身分狀態一起重建，於是任何「兩份狀態不同步」的 bug 都測不到。
// 實際發生過：核准之後 /kyc 顯示「法人・有效」，同一時間 /trade 說「尚未完成身分驗證」、
// /enterprise 說「需要法人身分」，因為那兩頁讀的是 provider 裡另一份沒被刷新的資料。
// 不要按「重新整理」、也不要 F5——這正是使用者的處境：核准是**別人**在別的地方做的，
// 他這個分頁什麼都不知道。切走再切回來（visibilitychange）應該就要更新。
await alice.page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
});
await alice.page.getByRole("link", { name: "前往交易" }).waitFor({ timeout: 30_000 });
console.log("✔ 管理員核准 KYC（回到分頁就看得到，不必重新載入）");

await alice.page.getByRole("link", { name: "前往交易" }).click();
await alice.page.waitForURL("**/trade");
await alice.page.getByRole("button", { name: "賣出" }).click();
await alice.page.waitForTimeout(400);
if (/尚未完成身分驗證/.test(await alice.page.locator("body").innerText())) {
  throw new Error("換頁之後 /trade 仍然認為沒有身分——兩份身分狀態又不同步了");
}
console.log("✔ 不重新載入、直接換頁，交易頁也認得身分");

const page = alice.page;
await page.goto(`${BASE}/trade`);
await page.getByRole("button", { name: "領取測試用 mTWD" }).click();
await page.locator('[data-testid="twd"]', { hasText: "100,000" }).waitFor({ timeout: 30_000 });
await buyFromBook(page, { country: "TW", tonnes: 1 }); // 在地優先：明確買國內核發的額度
// 市價買進：成交後立刻拆解成具體批次，使用者看到的是碳權批次而不是中介代幣
await marketBuy(page, { tonnes: 1 });
// 5 噸：這個量會把這個 demo 池的價格推高約兩成。原本前端用「現貨 × 1.05」授權，
// 於是 5 噸以上必定失敗（ERC20InsufficientAllowance），而畫面上的「最高支付」
// 顯示的是一個使用者根本不會付到的數字。授權改成從實際報價算之後才過得了。
await marketBuy(page, { tonnes: 5 });
console.log("✔ 掛單買進 + 市價買進");

// 量真的太大時，訊息要說「流動性不足」**並且給出還吃得下多少**。
// 只說「吃不下」等於叫人自己一路往下猜數字。
{
  await page.locator('[data-testid="tab-buy"]').click();
  await page.locator('[data-testid="mode-market"]').click();
  await page.locator('[data-testid="market-qty"]').fill("100000");
  await page.locator("text=流動性不足").first().waitFor({ timeout: 30_000 });
  const t = (await page.locator("main").innerText()).replace(/\s+/g, "");
  if (!/池子目前最多約[\d,.]+噸/.test(t)) throw new Error("沒有給出池子還吃得下多少");
  console.log("✔ 量太大時說流動性不足，並給出上限");
  await page.locator('[data-testid="market-qty"]').fill("1");
}

// 我的資產：買完之後看得到持有、成本與損益
await page.goto(`${BASE}/portfolio`);
await page.locator("text=資產總值").first().waitFor({ timeout: 30_000 });
await page.locator("text=平均成本").first().waitFor({ timeout: 30_000 });
console.log("✔ 我的資產頁");

// 自然人不能註銷：介面要講清楚，而不是給一顆按了會失敗的按鈕
await page.goto(`${BASE}/retire`);
await page.locator("text=自然人無法註銷額度").first().waitFor({ timeout: 30_000 });
const retireDisabled = await page.getByRole("button", { name: "註銷並取得憑證" }).first().isDisabled();
if (!retireDisabled) throw new Error("自然人的註銷按鈕應該是停用的");
console.log("✔ 自然人被擋下註銷，且畫面有說明");

// 換一台裝置（＝新的瀏覽器 context，localStorage 與虛擬 authenticator 都是空的）。
//
// 新模型下的正確行為**不是**自動還原——那台裝置沒有任何 passkey，還原了也簽不了字。
// 正確行為是：地址照樣顯示出來（它由登入帳號決定，伺服器算得出來），
// 畫面說清楚缺的是「這台裝置的鑰匙」，並給出兩條路：用既有 passkey 綁回來、
// 或申請加入等現有裝置核准。**不可以**說「尚未建立鏈上錢包」——那是假的。
{
  const other = await newUser(browser, "alice-2nd-device");
  await login(other.page, who("alice"));
  await other.page.goto(BASE);
  await other.page.getByRole("button", { name: /申請加入這台裝置/ }).waitFor({ timeout: 30_000 });
  const t = await other.page.locator("main").innerText();
  if (t.includes("尚未建立鏈上錢包")) throw new Error("換裝置卻說「尚未建立鏈上錢包」");
  if (!t.includes(address.slice(0, 6)) || !t.includes(address.slice(-4))) {
    throw new Error(`換裝置後沒有顯示原本的錢包地址，畫面上是：${t.slice(0, 300)}`);
  }
  // 新裝置不能自己把自己加進來：送出申請之後只會進待核准區，不會直接就緒。
  await other.page.getByRole("button", { name: /申請加入這台裝置/ }).click();
  await other.page.locator("text=已送出申請").waitFor({ timeout: 60_000 });
  if (await other.page.locator('[data-testid="account-ready"]').isVisible().catch(() => false)) {
    throw new Error("新裝置竟然不需要核准就能簽字——登入被盜就等於錢包被盜了");
  }
  console.log("✔ 換裝置：地址照舊、說得清楚，而且新裝置不能自己核准自己");

  // 回到原本那台裝置核准它，新裝置就能簽字了。這是「多裝置」的完整來回。
  await page.goto(`${BASE}/account`);
  await page.getByRole("button", { name: "核准", exact: true }).first().click();
  await waitOk(page, "已核准");
  await other.page.reload();
  await other.page.locator('[data-testid="account-ready"]').waitFor({ timeout: 60_000 });
  console.log("✔ 現有裝置核准之後，新裝置可以簽字，且仍是同一個地址");

  // 撤掉它，錢包回到一把金鑰。撤銷是即時的，不需要平台也不需要治理方。
  await page.goto(`${BASE}/account`);
  await page.getByRole("button", { name: "撤銷", exact: true }).first().click();
  await waitOk(page, "已移除");
  console.log("✔ 從另一台裝置撤銷遺失的裝置");
  await other.context.close();
}

// 掛失：凍結只要登得進來就按得下去，解凍要 passkey。凍結期間交易被擋，
// 但金鑰管理與解凍走得通——否則止血手段會變成陷阱。
{
  await page.goto(`${BASE}/account`);
  await page.getByRole("button", { name: "凍結我的錢包" }).click();
  await waitOk(page, "已凍結");
  await page.goto(`${BASE}/account`);
  await page.getByRole("button", { name: /用這台裝置解除凍結/ }).click();
  await waitOk(page, "已解除凍結");
  console.log("✔ 凍結 → 以現存 passkey 解凍");
}

// 合約重新部署之後，這個裝置記住的地址上沒有合約。這一段把那個狀況做出來：
// 把 localStorage 裡的地址換成一個不存在的，其餘（passkey id、公鑰、keyId）不動。
//
// 期待的行為是**什麼都不用做**。新模型下地址由登入帳號決定，伺服器隨時算得出來，
// 所以送交易時一律以伺服器回報的地址為準，localStorage 那份只是快取。
// 以快取為準的話，使用者會拿到一個他沒做錯任何事、重新整理就消失的紅字。
{
  await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem("co2x.credential"));
    c.address = "0x00000000000000000000000000000000dEaD0001";
    localStorage.setItem("co2x.credential", JSON.stringify(c));
  });
  // 用「掛買單」當那筆交易：它會走同一條 relay 路徑，但不消耗持有的批次，
  // 不會影響後面「自然人轉售、法人買下那一批」的步驟。
  await page.goto(`${BASE}/trade`);
  await page.locator('[data-testid="tab-buy"]').click();
  await page.locator('[data-testid="mode-limit"]').click();
  await page.locator('[data-testid="place-bid-form"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-testid="bid-country"]').selectOption("TW");
  await page.locator('[data-testid="bid-tonnes"]').fill("0.5");
  await page.locator('[data-testid="bid-price"]').fill("11");
  await page.locator('[data-testid="submit-bid"]').click();
  await waitOk(page, "掛買單");
  const body = await page.locator("main").innerText();
  if (body.includes("在目前這條鏈上不存在")) throw new Error("地址只是快取過期，卻把錯誤丟給使用者");
  console.log("✔ localStorage 的地址過期時，交易照常送出（以伺服器的地址為準）");
}

// 自然人的出場方式是轉售：在交易頁上架
await page.goto(`${BASE}/trade`);
const aliceBatch = await sellOnBook(page, { tonnes: 1, price: 900 });
console.log("✔ 自然人轉售上架");

// 法人買下自然人的掛單並註銷——官方端只有事業能做這件事
const corp = await newUser(browser, "corp");
await login(corp.page, who("corp-buyer"));
await createPasskeyAccount(corp.page);
await applyKyc(corp.page, "corporate", "12345678", "買方股份有限公司");
await adminApproveAllKyc(admin.page);
await waitKycActive(corp.page);
await corp.page.goto(`${BASE}/trade`);
await corp.page.getByRole("button", { name: "領取測試用 mTWD" }).click();
await corp.page.locator('[data-testid="twd"]', { hasText: "100,000" }).waitFor({ timeout: 30_000 });
// 指名買 alice 剛上架的那一批：書上隨時有幾十張國內掛單，不指名就證明不了
// 「法人買下**自然人**的掛單」這件事。
await buyFromBook(corp.page, { country: "TW", match: `批次 #${aliceBatch}`, tonnes: 1 });
console.log("✔ 法人買下自然人的掛單");

// 買完之後持有量是**非同步**重抓的，成功通知出現的那一刻還不一定抓回來了。
// 鏈上資料一多，這個空窗就從幾十毫秒變成好幾秒——等到批次真的出現再讀，
// 不要讀到還沒更新的「—」然後在 regex 上炸掉。
const batchesEl = corp.page.locator('[data-testid="batches"]');
await batchesEl.filter({ hasText: /#\d+/ }).waitFor({ timeout: 30_000 });
const bought = (await batchesEl.innerText()).match(/#(\d+)/)[1];
// 註銷在另一頁；需先簽註銷暨移轉委任書
await retireOnPage(corp.page, { beneficiary: "買方股份有限公司", tonnes: 1 });
await waitOk(corp.page, `註銷批次 #${bought} 1 噸完成`);
// 憑證已併入「我的資產」頁
await corp.page.goto(`${BASE}/portfolio`);
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

await corp.page.goto(`${BASE}/portfolio`);
await corp.page.locator("text=下載 PDF").first().waitFor({ timeout: 30_000 });
const firstTitle = (await corp.page.locator("text=憑證 #").first().textContent()).trim();
const certId = Number(firstTitle.replace(/\D/g, ""));
const pdfRes = await corp.page.request.get(`${BASE}/api/certificates/${certId}/pdf`);
if (pdfRes.status() !== 200) throw new Error(`PDF 下載失敗 ${pdfRes.status()}`);
console.log("✔ 使用者可下載 PDF，SHA-256", pdfRes.headers()["x-sha256"]);

// 國外額度：買得到，但註銷用途受限（增量抵換在鏈上就被擋下）
await corp.page.goto(`${BASE}/trade`);
await buyFromBook(corp.page, { match: "北海道", tonnes: 1 });
await corp.page.goto(`${BASE}/retire`);
const targetSelect = corp.page.locator("select").first();
const jpValue = await targetSelect.locator("option", { hasText: "北海道" }).first().getAttribute("value");
await targetSelect.selectOption(jpValue);
await corp.page.locator("text=這是國外減量額度").first().waitFor({ timeout: 30_000 });
// 直接讀 DOM 的 disabled 屬性：option 的 isDisabled() 語意在不同版本不一致，不值得賭
const offsetDisabled = await corp.page.locator("select").nth(1)
  .evaluate((el) => [...el.options].find((o) => o.value === "2")?.disabled);
if (!offsetDisabled) throw new Error("國外額度的增量抵換選項應該是停用的");
console.log("✔ 國外額度買得到，增量抵換被擋下");

// 託管揭露：公開頁面，不必登入
await corp.page.goto(`${BASE}/custody`);
await corp.page.locator("text=資產託管揭露").first().waitFor({ timeout: 30_000 });
await corp.page.locator("text=託管總量").first().waitFor({ timeout: 30_000 });
console.log("✔ 託管揭露頁");

// 管理後台：各國費率獨立設定
await admin.page.goto(`${BASE}/admin`);
await admin.page.getByRole("button", { name: "費率設定" }).click();
const jpRow = admin.page.locator('[data-testid="fee-row"]', { hasText: "JP" }).first();
await jpRow.waitFor({ timeout: 30_000 });
await jpRow.locator('input[type="number"]').first().fill("250");
await jpRow.getByRole("button", { name: "設為專屬" }).click();
await waitOk(admin.page, "設定 JP 費率完成");
console.log("✔ 各國費率獨立設定");

await browser.close();
if (n < 1) { console.error("expected ≥1 certificate"); process.exit(1); }
console.log("E2E OK");
