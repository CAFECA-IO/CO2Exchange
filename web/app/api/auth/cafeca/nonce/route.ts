import { cookies } from "next/headers";
import { newNonce } from "@/lib/server/cafeca/nonce";
import { handleError, ok } from "@/lib/server/api";

/// 發一個登入用的 nonce，並把它綁在**這個瀏覽器**上。
///
/// 綁定是靠一個 httpOnly cookie。少了這一步，一組在別處騙到或側錄到的有效回應
/// 可以從攻擊者自己的瀏覽器送進來就登入成功——跨裝置 QR 那條路尤其危險
/// （把本站的登入 QR 放到自己的頁面上誘騙掃描，也就是 QRLjacking）。
/// 有了 cookie，攻擊者還得同時拿到受害者瀏覽器裡的這一個值。
///
/// `sameSite: "lax"` 而不是 `strict`：整頁導向那條路是從錢包網域跳回來的，
/// strict 會讓 cookie 在那個請求裡消失，於是所有行動裝置都登不進來。
export const NONCE_COOKIE = "cafeca_nonce";

export async function POST() {
  try {
    const { nonce, expiresAt } = newNonce();
    (await cookies()).set(NONCE_COOKIE, nonce, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 5 * 60,
    });
    return ok({ nonce, expiresAt });
  } catch (e) { return handleError(e); }
}
