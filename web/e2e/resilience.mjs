// 暫時性的失敗不可以變成永久卡住。
//
// 這支守的是一個真的發生過的 bug：`/api/account` 只要失敗一次，
// `walletFor` 就永遠停在 null，門檻畫面卡在「讀取錢包狀態中…」——
// 沒有原因、沒有重試、沒有出口。正式站與本機都中過。
//
// 三件事要一直成立：
//   ① 暫時性失敗會自己重試並成功，使用者完全不必知道發生過。
//   ② 真的失敗（重試也救不回）時，畫面說得出原因，而且給得出一顆重試鍵。
//   ③ 按下重試會真的重新查，而且成功之後回到正常畫面。
import { BASE, launch, login, newUser, who } from "./lib.mjs";

const ok = (c, m) => { if (!c) throw new Error(m); console.log("  ✓", m); };
const browser = await launch();
let failed = null;

try {
  // ── ① 失敗一次會自動救回來 ─────────────────────────────
  {
    const u = await newUser(browser, "resilient");
    await login(u.page, who("resilient"));
    let n = 0;
    await u.page.route("**/api/account", (route) => {
      // 只擋第一次（且只擋不帶查詢字串的那一支，避免影響 ?address= 的檢查）
      if (n++ === 0) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "CHAIN_UNREACHABLE", message: "chain unreachable", retriable: true } }) });
      return route.continue();
    });
    await u.page.goto(`${BASE}/trade`);
    // 重試的退避是 0.4s，所以幾秒內就該看到正常的門檻畫面
    await u.page.locator("main").getByText(/建立你的鏈上錢包|這台裝置還不能簽署交易/).first().waitFor({ timeout: 20_000 });
    ok(n >= 2, `暫時性失敗會自動重試（/api/account 共 ${n} 次），使用者不必知道`);
    ok(!(await u.page.getByText("讀不到你的錢包狀態").isVisible().catch(() => false)),
       "而且不會為了一次抖動就跳錯誤畫面");
    await u.context.close();
  }

  // ── ②③ 一直失敗：要說原因，要能重試 ────────────────────
  {
    const u = await newUser(browser, "broken");
    await login(u.page, who("broken"));
    let down = true;
    let calls = 0;
    await u.page.route("**/api/account", (route) => {
      calls++;
      if (down) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "CHAIN_UNREACHABLE", message: "無法連線到區塊鏈節點（http://127.0.0.1:28545）。", retriable: true } }) });
      return route.continue();
    });

    const t0 = Date.now();
    await u.page.goto(`${BASE}/trade`);
    await u.page.getByText("讀不到你的錢包狀態").waitFor({ timeout: 30_000 });
    const secs = Math.round((Date.now() - t0) / 1000);
    ok(secs < 20, `重試用完之後 ${secs} 秒內就講話，不是無限期轉圈`);

    const body = await u.page.locator("main").innerText();
    ok(body.includes("無法連線到區塊鏈節點"), "而且把伺服器寫好的人話原因顯示出來");
    ok(!/讀取錢包狀態中/.test(body), "不再停在「讀取錢包狀態中…」");
    ok(await u.page.locator('[data-testid="wallet-retry"]').isVisible(), "畫面上有一顆重試鍵");

    // ③ 修好之後按重試，要回到正常畫面
    down = false;
    const before = calls;
    await u.page.locator('[data-testid="wallet-retry"]').click();
    await u.page.locator("main").getByText(/建立你的鏈上錢包|這台裝置還不能簽署交易/).first().waitFor({ timeout: 30_000 });
    ok(calls > before, "按下重試會真的重新查一次");
    ok(!(await u.page.getByText("讀不到你的錢包狀態").isVisible().catch(() => false)), "成功之後錯誤畫面收起來");
    await u.context.close();
  }

  console.log("\n韌性：全部通過");
} catch (e) {
  failed = e;
} finally {
  await browser.close();
}
if (failed) { console.error(failed); process.exit(1); }
