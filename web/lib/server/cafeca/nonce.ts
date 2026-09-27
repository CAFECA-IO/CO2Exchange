import "server-only";
import crypto from "node:crypto";

/// 登入用的一次性 nonce。
///
/// 它要同時擋掉兩件事：
///   · **重送**——別人側錄到一組回應，稍後拿來再登入一次。
///   · **挪用**——在別的網站騙到的簽章，拿到這裡用。
///
/// 第二件由 `domain` 比對負責（見 verify.ts）；這裡負責第一件，做法是兩道：
///
///   1. nonce 帶 HMAC，所以**不是我們發的就驗不過**，不需要為了記住它而寫任何狀態。
///      重開伺服器之後上一輪發出去的 nonce 仍然有效，這是刻意的：正在登入的人
///      不該因為一次部署就卡住。
///   2. 用過的放進記憶體裡的集合，**同一個 nonce 不會成立第二次**。
///      這一份會隨重啟消失——代價是重啟後那 5 分鐘內的重送擋不到，
///      而那個窗口需要攻擊者同時拿到回應與使用者的 cookie。Phase 0 接受；
///      正式環境換成 Redis 之類的共用儲存（這支檔案的介面不用改）。
///
/// nonce 本身不代表任何人。真正把它綁到「這個瀏覽器」的是那個 httpOnly cookie
/// （見 app/api/auth/cafeca/nonce/route.ts）——沒有 cookie 就沒有 nonce 可以比對。

const TTL_MS = 5 * 60_000;

function secret(): string {
  const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!s) {
    // 沒有它，nonce 的 HMAC 就成了任何人都算得出來的值。開發時給一把固定的假鑰匙，
    // 正式環境寧可起不來也不要靜悄悄地失去保護。
    if (process.env.NODE_ENV === "production") throw new Error("缺少 AUTH_SECRET，CAFECA 登入的 nonce 無法簽章");
    return "dev-only-insecure-secret";
  }
  return s;
}

const b64u = (b: Buffer) => b.toString("base64url");

/// 發一個新的 nonce。格式是 `<隨機>.<到期秒>.<HMAC>`，全部落在 SDK 允許的
/// `[A-Za-z0-9_-]` 8–128 字元裡（所以分隔符用 `~`，不用 `.`）。
export function newNonce(): { nonce: string; expiresAt: number } {
  const expiresAt = Math.floor((Date.now() + TTL_MS) / 1000);
  const rand = b64u(crypto.randomBytes(18));
  const body = `${rand}~${expiresAt}`;
  const mac = b64u(crypto.createHmac("sha256", secret()).update(body).digest()).slice(0, 27);
  return { nonce: `${body}~${mac}`, expiresAt };
}

const used = new Map<string, number>();

function sweep() {
  const now = Date.now();
  for (const [n, t] of used) if (now - t > TTL_MS * 2) used.delete(n);
}

/// 驗證並**當場作廢**。回傳不通過的理由，通過則回 null。
///
/// 「當場作廢」是刻意的：呼叫端不論後面成不成功都不能讓同一個 nonce 再用一次。
/// 把作廢放在後面（例如登入成功才標記）會留下一個窗口——簽章驗證失敗的請求
/// 可以無限次重送，而那正是暴力嘗試需要的。
export function consumeNonce(nonce: string): string | null {
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_~-]{8,128}$/.test(nonce)) return "nonce 格式不正確";

  sweep();
  if (used.has(nonce)) return "這個 nonce 已經用過了";
  used.set(nonce, Date.now());

  const parts = nonce.split("~");
  if (parts.length !== 3) return "nonce 格式不正確";
  const [rand, expStr, mac] = parts;
  const body = `${rand}~${expStr}`;
  const want = b64u(crypto.createHmac("sha256", secret()).update(body).digest()).slice(0, 27);
  // 定長比較。這裡的時間差洩漏的是「猜對了幾個字元」，而 nonce 只有 5 分鐘壽命——
  // 但寫對的成本是一行，沒有理由不寫。
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return "nonce 不是本站發出的";

  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp * 1000 < Date.now()) return "nonce 已過期";
  return null;
}
