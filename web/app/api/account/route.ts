import { handleError, ok } from "@/lib/server/api";
import { requireRole } from "@/lib/server/roles";
import { walletOf } from "@/lib/server/wallet";

/// GET → 登入者的錢包狀態。
///
/// 這一支以前還有 POST（登記一把 passkey、必要時部署錢包）與兩個子路徑
/// （待核准裝置、凍結）。它們連同 `/api/relay` 與 `/api/relay/prepare` 一起被刪掉了，
/// 因為錢包不再是本站部署的 `PasskeyAccount`：
///
///   · 金鑰與裝置管理在 CAFECA 錢包裡做（`manageUrl`）。本站沒有能力、
///     也不該有能力替使用者加一把金鑰或凍結他的帳戶。
///   · 交易由使用者的帳戶自己執行（簽章通道的 `sendCalls`），
///     不再是「本站錢包簽字、relayer 代送」。
///
/// 少掉的那些路徑各自都是一個可以被打的面。這裡的縮減不是整理，是減少攻擊面。
export async function GET() {
  try {
    const m = await requireRole("user");
    return ok(await walletOf(m.address));
  } catch (e) { return handleError(e); }
}
