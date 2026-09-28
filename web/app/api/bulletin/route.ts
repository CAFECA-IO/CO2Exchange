import { bulletin } from "@/lib/server/bulletin";
import { handleError, ok } from "@/lib/server/api";

/// 公開資訊：不需要登入。公告的意義就在於任何人都看得到。
/// `?limit=` 每一類最多回幾筆（預設 200，0–5000）；總數在 `counts`。
export async function GET(req: Request) {
  try {
    const n = Number(new URL(req.url).searchParams.get("limit") ?? 200);
    const limit = Number.isInteger(n) && n >= 0 && n <= 5000 ? n : 200;
    return ok(await bulletin(limit));
  } catch (e) { return handleError(e); }
}
