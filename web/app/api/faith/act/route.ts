import { buildAction, type ActionKind } from "@/lib/server/faith/actions";
import { handle, HttpError, me } from "@/lib/server/roles";
import { walletOf } from "@/lib/server/wallet";

/// 確認的那一刻，把動作**重新**算一次。
///
/// 為什麼不沿用對話那一輪算好的 calls：中間隔了使用者讀確認卡的那幾秒到幾分鐘。
/// 這段時間裡掛單可能被別人吃掉、餘額可能變、身分可能過期。沿用舊的 calldata，
/// 最好的情況是交易 revert（使用者白簽一次），最壞的情況是他以 30 秒前的條件
/// 買到一個已經不一樣的東西。
///
/// 另一個理由更根本：**前端傳來的東西一律不可信。** 這一支只收動作名稱與純量參數，
/// calldata 一律在伺服器端用 ABI 重編。前端（或被注入的模型）就算改了 calls，
/// 也送不出去——因為送出去的那一份不是它給的。
export async function POST(req: Request) {
  try {
    const { kind, params } = (await req.json()) as { kind?: string; params?: Record<string, unknown> };
    if (!kind) throw new HttpError(400, "缺少 kind");
    const who = await me();
    const wallet = who ? await walletOf(who.email, who.id).catch(() => null) : null;
    const preview = await buildAction(kind as ActionKind, params ?? {}, {
      address: wallet?.exists ? wallet.address : undefined,
      email: who?.email, userId: who?.id,
    });
    return Response.json(preview);
  } catch (e) { return handle(e); }
}
