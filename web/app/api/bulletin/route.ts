import { bulletin } from "@/lib/server/bulletin";
import { handleError, ok } from "@/lib/server/api";

/// 公開資訊：不需要登入。公告的意義就在於任何人都看得到。
export async function GET() {
  try {
    return ok(await bulletin());
  } catch (e) { return handleError(e); }
}
