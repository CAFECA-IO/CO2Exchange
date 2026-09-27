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
export async function signInWithCafeca(): Promise<string> {
  const c = (await sdk()).create({ wallet: WALLET });
  const response = await c.signIn({ nonce, statement: STATEMENT, claims: CLAIMS });
  return JSON.stringify(response);
}

/// 整頁導向：行動裝置與擋彈出視窗的環境（App 內建瀏覽器）走這條。
export async function redirectToCafeca(redirectUri: string): Promise<void> {
  const c = (await sdk()).create({ wallet: WALLET });
  await c.redirect({ nonce: await nonce(), statement: STATEMENT, claims: CLAIMS, redirectUri });
}

/// 從導向回來時呼叫。沒有結果就回 null（代表這一次不是登入導向回來的）。
export async function handleCafecaRedirect(): Promise<string | null> {
  const r = (await sdk()).handleRedirect();
  if (!r) return null;
  if (r.error) throw new Error(messageFor(r.error));
  return r.response ? JSON.stringify(r.response) : null;
}
