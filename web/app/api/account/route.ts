import { handleError, ok } from "@/lib/server/api";
import { requireRole } from "@/lib/server/roles";
import { devWalletOf, walletOf } from "@/lib/server/wallet";
import { devSignerFor } from "@/lib/server/ledger/write";

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
    // 開發用登入（本機鏈、非 production）的帳戶不是 CAFECA 身分，拿它去問 CAFECA 沒有意義——
    // 而且沒網路的時候（CI、離線展示）整個內頁會卡在「讀不到你的帳戶狀態」。
    if (await devSignerFor(m.address)) return ok(await devWalletOf(m.address, m.kycLevel));
    return ok(await walletOf(m.address));
  } catch (e) { return handleError(e); }
}
