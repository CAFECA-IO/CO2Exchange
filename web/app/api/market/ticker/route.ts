import { ticker } from "@/lib/server/ticker";
import { handleError, ok } from "@/lib/server/api";

/// 公開行情：不需登入，landing page 直接讀。
export async function GET(req: Request) {
  try {
    const h = Number(new URL(req.url).searchParams.get("hours") ?? 24 * 7);
    const rangeHours = Number.isFinite(h) && h > 0 && h <= 24 * 365 ? h : 24 * 7;
    return ok(await ticker(rangeHours));
  } catch (e) { return handleError(e); }
}
