import { requireRole } from "@/lib/server/roles";
import { ApiError, handleError, ok } from "@/lib/server/api";
import { ledgerFees, ledgerSetFees } from "@/lib/server/ledger/registry";

/// 各國費率表。
///
/// GET 是公開的——使用者本來就該知道自己要付多少手續費，不必登入才看得到。
/// POST 需要管理員，由營運金鑰簽一筆帳本的 fees 事件（授權門檻大於 1 時變成待簽提案）。

export async function GET() {
  try {
    return ok(ledgerFees());
  } catch (e) { return handleError(e); }
}

/// POST { country, custom, tradeBps, retireFeePerTonne } → 設定單一轄區
/// POST { defaults: true, tradeBps, retireFeePerTonne }   → 設定預設值
export async function POST(req: Request) {
  try {
    await requireRole("admin");
    const body = await req.json();
    const tradeBps = Number(body.tradeBps ?? 0);
    const retire = BigInt(Math.round(Number(body.retireFeePerTonne ?? 0) * 1e6));
    if (!Number.isInteger(tradeBps) || tradeBps < 0 || tradeBps > 500)
      throw new ApiError("INVALID_PARAM", "交易手續費須為 0–500 bps（上限 5%）", { param: "tradeBps" });
    if (retire < 0n) throw new ApiError("INVALID_PARAM", "註銷手續費不可為負", { param: "retireFeePerTonne" });

    // 取消自訂 = 設回預設值（帳本沒有「刪除」）
    if (body.defaults) return ok(await ledgerSetFees("", tradeBps, retire));
    const country = String(body.country ?? "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw new ApiError("INVALID_PARAM", "國別代碼不正確", { param: "country" });
    if (!body.custom) {
      const f = ledgerFees();
      return ok(await ledgerSetFees(country, f.defaultTradeBps, BigInt(f.defaultRetireFeePerTonne)));
    }
    return ok(await ledgerSetFees(country, tradeBps, retire));
  } catch (e) { return handleError(e); }
}
