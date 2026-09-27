"use client";
import { postJson } from "./fetchJson";

/// 「以 CAFECA 登入」的瀏覽器端。
///
/// 這一支**不驗證任何東西**，只負責把登入請求交給錢包、把回應原封不動送回後端。
/// 前端拿到的回應可以被竄改，所以任何「看起來已經登入了」的判斷都必須等後端說話——
/// 驗證在 lib/server/cafeca/verify.ts，那裡才是真正決定你是誰的地方。

const WALLET = process.env.NEXT_PUBLIC_CAFECA_WALLET ?? "https://cafeca.io";

/// 簽章通道。登入時帶 `channel: true`、使用者同意之後才拿得到。
///
/// **通道不是授權。** 每一筆請求都會在 CAFECA 錢包顯示我們寫的說明、
/// 以及錢包自己解析出來的實際內容，由使用者按下去才簽——網站沒有辦法
/// 在使用者不知情的情況下簽出任何東西。所以「開了通道」不等於「可以動他的錢」，
/// 這一點在介面上也要這樣講，不要寫成「授權本站」。
export type Channel = {
  id: string;
  signMessage(message: string, description: Description): Promise<{ signature: `0x${string}` }>;
  signTypedData(typedData: unknown, description: Description): Promise<{ signature: `0x${string}` }>;
  sendCalls(
    calls: { to: string; data?: string; value?: string }[],
    description: Description,
    opts?: { transport?: "popup" | "relay"; onPending?: (p: { link: string }) => void },
  ): Promise<{ txHash: `0x${string}`; success: boolean }>;
};

/// 每一筆都必須附說明，沒有說明錢包會直接拒絕。
/// 而且**要寫得和實際內容一致**：錢包會把我們的說明標成「網站說明」，
/// 並在下面列出它自己解析出來的實際操作供使用者核對。兩者不符，
/// 使用者看到的就是一個在騙他的網站——那比沒有說明更糟。
export type Description = { title: string; detail?: string };

type Connect = {
  signIn(opts: Record<string, unknown>): Promise<unknown>;
  redirect(opts: Record<string, unknown>): Promise<unknown>;
  authLink(opts: Record<string, unknown>): string;
  channel(response: unknown): Promise<Channel | null>;
  restoreChannel(id: string): Promise<Channel | null>;
};
type Sdk = {
  create(o: { wallet: string }): Connect;
  handleRedirect(): { response?: unknown; error?: string } | null;
};

declare global {
  interface Window { CafecaConnect?: Sdk }
}

let loading: Promise<Sdk> | undefined;

/// SDK 由錢包網域提供，第一次用到才載。
///
/// 載入失敗就是登入不能用——不要靜悄悄地退回別的路徑。這個網域同時決定了
/// 「使用者會在哪裡看到確認畫面」，換掉它等於換掉整個信任根，
/// 所以它來自建置時的環境變數，不會被頁面上的任何東西影響。
function sdk(): Promise<Sdk> {
  if (window.CafecaConnect) return Promise.resolve(window.CafecaConnect);
  loading ??= new Promise<Sdk>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `${WALLET}/sdk/cafeca-connect.js`;
    s.async = true;
    s.onload = () => (window.CafecaConnect ? resolve(window.CafecaConnect) : reject(new Error("CAFECA SDK 載入了但沒有註冊")));
    s.onerror = () => { loading = undefined; reject(new Error(`連不上 CAFECA 錢包（${WALLET}）`)); };
    document.head.appendChild(s);
  });
  return loading;
}

const nonce = () => postJson<{ nonce: string; expiresAt: number }>("/api/auth/cafeca/nonce", {}).then((r) => r.nonce);

const STATEMENT = "登入 TideBit-DeFi 碳權交易所";
/// 兩項都是使用者可以逐項取消的。
///   · kyc_level —— 決定 KYCRegistry 的 tier，沒有它就只能看不能交易。
///   · handle    —— 純顯示用。拒絕了就顯示地址縮寫，不影響任何功能。
const CLAIMS = ["kyc_level", "handle"];
const CHANNEL_KEY = "cafeca.channel";

export type CafecaErrorCode =
  | "access_denied" | "closed" | "popup_blocked" | "timeout" | "invalid_nonce"
  | "rejected" | "channel_closed" | "invalid_request" | "unknown";

export function messageFor(code: string): string {
  switch (code) {
    case "access_denied": return "你在 CAFECA 錢包裡拒絕了這次登入";
    case "closed": return "登入視窗被關掉了";
    case "popup_blocked": return "瀏覽器擋下了登入視窗。請允許彈出視窗，或改用手機掃碼登入";
    case "timeout": return "登入逾時，請再試一次";
    case "invalid_nonce": return "登入請求已失效，請再試一次";
    case "rejected": return "你在 CAFECA 錢包裡拒絕了這筆簽章";
    case "channel_closed":
    case "CHANNEL_CLOSED": return "簽章通道已關閉。請重新登入一次以開啟——沒有它就沒辦法簽委託單";
    case "invalid_request": return "這筆請求被錢包擋下了（缺少說明或內容不合規）";
    default: return "登入沒有完成";
  }
}

/// 彈出視窗登入。**必須在點擊事件裡直接呼叫**，否則瀏覽器會擋下視窗。
///
/// 所以 nonce 用函式的形式交給 SDK，而不是先 await 再呼叫 signIn——
/// 先 await 會讓 signIn 離開使用者手勢的作用範圍，於是每一次登入都被擋。
/// 這個坑很安靜：開發時彈出視窗多半已被允許，一上線才每個人都登不進去。
/// `channel: true` 同時要求開啟簽章通道。使用者可以只登入、不開通道——
/// 那樣仍然登得進來，只是下不了單也送不了交易，所以介面要分得開這兩件事：
/// 「沒登入」與「登入了但沒開通道」需要的下一步不一樣。
export async function signInWithCafeca(): Promise<string> {
  const c = (await sdk()).create({ wallet: WALLET });
  const response = await c.signIn({ nonce, statement: STATEMENT, claims: CLAIMS, channel: true });
  // 通道 id 存起來，下次進站不必重新開。存的是 id 不是金鑰——網站端的私鑰由 SDK
  // 以不可匯出的 CryptoKey 放在 IndexedDB，我們碰不到它，也就洩漏不了它。
  try {
    const ch = await c.channel(response);
    if (ch?.id) localStorage.setItem(CHANNEL_KEY, ch.id);
    else localStorage.removeItem(CHANNEL_KEY);
  } catch { /* 沒開通道不影響登入本身 */ }
  return JSON.stringify(response);
}

/// 整頁導向：行動裝置與擋彈出視窗的環境（App 內建瀏覽器）走這條。
export async function redirectToCafeca(redirectUri: string): Promise<void> {
  const c = (await sdk()).create({ wallet: WALLET });
  await c.redirect({ nonce: await nonce(), statement: STATEMENT, claims: CLAIMS, channel: true, redirectUri });
}

/// 這個瀏覽器還留著的通道。沒有、或使用者已經在 CAFECA 關掉它，就回 null。
export async function currentChannel(): Promise<Channel | null> {
  let id: string | null = null;
  try { id = localStorage.getItem(CHANNEL_KEY); } catch { return null; }
  if (!id) return null;
  try {
    const ch = await (await sdk()).create({ wallet: WALLET }).restoreChannel(id);
    if (!ch) localStorage.removeItem(CHANNEL_KEY);
    return ch;
  } catch {
    return null;
  }
}

/// 一筆鏈上呼叫。**站內沿用 `target` 這個欄位名**（各頁本來就這樣組），
/// 送進通道之前才轉成 CAFECA 的 `to`——轉換只寫在一個地方。
export type Call = { target: `0x${string}`; value: bigint; data: `0x${string}` };

/// 說明的長度上限由錢包定：title ≤ 60、detail ≤ 500，超過會被拒絕。
/// 在這裡截斷而不是讓錢包拒絕：一個因為標題多兩個字而失敗的交易，
/// 錯誤碼會是 `invalid_request`，沒有人查得出原因。
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const desc = (d: Description) => ({
  title: clip(d.title, 60),
  detail: d.detail ? clip(d.detail, 500) : undefined,
});

/// 請使用者簽一筆 EIP-712。
///
/// **typedData 必須是伺服器與前端共用的那一份**（`lib/bank/order-typed.ts`）：
/// 兩邊各組一份是這類協定最常見的壞法，欄位順序差一個 digest 就不一樣，
/// 而錯誤訊息只會說「簽章無效」。
export async function signTypedDataViaChannel(typedData: unknown, description: Description): Promise<`0x${string}`> {
  const ch = await currentChannel();
  if (!ch) throw new Error("CHANNEL_CLOSED");
  const { signature } = await ch.signTypedData(typedData, desc(description));
  return signature;
}

/// 送一批鏈上呼叫，由**使用者自己的帳戶**執行，gas 由平台贊助。
///
/// 這取代了原本「本站 PasskeyAccount 簽字 → relayer 代送」那條路。差別不只是實作：
/// 現在鏈上的 `msg.sender` 是使用者的 CAFECA 帳戶，不是我們替他保管的合約錢包。
/// 「錢是使用者自己動的」這句話因此在鏈上成立，而不只是我們的說法——
/// 對一次移轉（§26）那條論證來說，這個差別是實質的。
///
/// 錢包會把我們寫的說明標成「網站說明」，並在下面列出它自己解析出來的實際操作
/// 供使用者核對。**兩者必須一致**：說明寫「購買 1,000 kg」而實際是 approve 無限額度，
/// 使用者看到的就是一個在騙他的網站——那比沒有說明更糟。
///
/// `transport`：`popup` 要在使用者手勢裡呼叫；`relay` 走 CAFECA 中繼信箱，
/// 使用者在手機上的 CAFECA 會看到提示，`onPending` 給一個可以做成 QR 的連結。
export async function sendCallsViaChannel(
  calls: Call[],
  description: Description,
  opts?: { transport?: "popup" | "relay"; onPending?: (p: { link: string }) => void },
): Promise<{ txHash: `0x${string}`; success: boolean }> {
  const ch = await currentChannel();
  if (!ch) throw new Error("CHANNEL_CLOSED");
  return ch.sendCalls(
    calls.map((c) => ({ to: c.target, data: c.data, value: c.value ? c.value.toString() : undefined })),
    desc(description),
    opts,
  );
}

/// 從導向回來時呼叫。沒有結果就回 null（代表這一次不是登入導向回來的）。
export async function handleCafecaRedirect(): Promise<string | null> {
  const r = (await sdk()).handleRedirect();
  if (!r) return null;
  if (r.error) throw new Error(messageFor(r.error));
  return r.response ? JSON.stringify(r.response) : null;
}
