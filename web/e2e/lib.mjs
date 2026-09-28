// 共用：瀏覽器、使用者 context、開發用登入
import { chromium } from "playwright";

export const BASE = process.env.BASE_URL ?? "http://localhost:10010";

/// 每一次執行給一般使用者一組新的 email。
///
/// 開發用登入從這個字串推出一個固定地址，而帳本會記得那個地址的身分、餘額與持倉。
/// 固定字串因此等於跨執行共用同一個帳戶：第二次跑會帶著上一次的狀態開始，
/// 「申請身分」「入金之後餘額是多少」這種步驟就會爆掉——爆的不是功能，是測試自己留下的狀態。
/// 管理員與查驗機構不能這樣做：它們的權限是 ADMIN_ADDRESSES / VERIFIER_ADDRESSES 白名單，
/// 而開發用登入是從這個字串推出一個固定地址，所以那兩個標籤必須維持不變。
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/// 所有 API 都回 `{ok,data}` / `{ok,error}` 的信封（見 lib/server/api.ts）。
/// e2e 想看的幾乎都是信封裡那一層，所以在這裡拆一次，各個測試就不必各拆各的。
export const unwrap = (body) =>
  body && typeof body === "object" && "ok" in body ? (body.ok ? body.data : body.error) : body;

export const who = (name) => `${name}-${RUN}@example.com`;

export async function launch() {
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}

/// 新的瀏覽器 context = 新的使用者（獨立 cookie 與 localStorage）
export async function newUser(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[${label} pageerror]`, e.message));
  return { context, page, label };
}

/// 登入：走開發用登入（NextAuth 的 `dev` credentials，非 production 才有）。
///
/// 畫面上的登入只剩「以 CAFECA 登入」，那要真的 CAFECA 錢包，瀏覽器測試模擬不出來。
/// 開發用登入從字串推出一個固定地址，交易由伺服器代簽（`devSigning`），
/// 所以登入之後整個交易流程在畫面上照常走——走不到的只有 CAFECA 錢包那一個視窗。
///
/// 用 context 的 request（與頁面共用 cookie）直接打 csrf → callback，不經過畫面：
/// 這樣也沒有「表單在 CSRF token 回來之前就送出」那個間歇性的坑。
export async function login(page, label) {
  const req = page.context().request;
  const { csrfToken } = await (await req.get(`${BASE}/api/auth/csrf`)).json();
  await req.post(`${BASE}/api/auth/callback/dev`, { form: { csrfToken, address: label, json: "true" }, maxRedirects: 0 });
  const me = await (await req.get(`${BASE}/api/me`)).json();
  const address = me?.data?.address;
  if (!address) throw new Error(`開發用登入失敗：${label}（伺服器要跑在非 production、且沒有關掉開發用登入）`);
  await page.goto(BASE);
  return address;
}

// 以前這裡還有建 passkey 帳戶、在畫面上填 KYC、在掛單簿上點買點賣的步驟。
// 帳戶改為 CAFECA 身分、交易改成帳本委託之後，那些畫面與按鈕都換了；
// 帳本的交易流程改由 scripts/e2e-ledger-*.mjs 以 API 逐項測（npm run test:ledger-write 等），
// 這裡的瀏覽器測試只測畫面本身該守住的東西（地球、門檻畫面的韌性、費思）。
