import { buildAction, type ActionKind } from "@/lib/server/faith/actions";
import { me } from "@/lib/server/roles";
import { ApiError, handleError, ok } from "@/lib/server/api";

/// 確認的那一刻，把動作**重新**算一次。
///
/// 為什麼不沿用對話那一輪算好的預覽：中間隔了使用者讀確認卡的那幾秒到幾分鐘。
/// 這段時間裡掛單可能被別人吃掉、餘額可能變、身分可能過期。沿用舊的欄位，
/// 最好的情況是帳本拒收（使用者白簽一次），最壞的情況是他以 30 秒前的條件
/// 買到一個已經不一樣的東西。
///
/// 另一個理由更根本：**前端傳來的東西一律不可信。** 這一支只收動作名稱與純量參數，
/// 要簽的欄位一律在伺服器端從帳本現況重算；要簽的 EIP-712 訊息再由 /api/ledger 組。
/// 前端（或被注入的模型）就算改了欄位，簽出去的那一份也不是它給的。
export async function POST(req: Request) {
  try {
    const { kind, params } = (await req.json()) as { kind?: string; params?: Record<string, unknown> };
    if (!kind) throw new ApiError("MISSING_PARAM", "缺少 kind", { param: "kind" });
    const who = await me();
    const preview = await buildAction(kind as ActionKind, params ?? {}, {
      // 帳戶就是登入的地址（CAFECA 帳戶或本機的開發帳戶都能簽帳本委託）
      address: who?.address,
      userId: who?.id,
    });
    return ok(preview);
  } catch (e) { return handleError(e); }
}
