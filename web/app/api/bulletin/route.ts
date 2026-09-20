import { bulletin } from "@/lib/server/bulletin";
import { handle } from "@/lib/server/roles";

/// 公開資訊：不需要登入。公告的意義就在於任何人都看得到。
export async function GET() {
  try {
    return Response.json(await bulletin());
  } catch (e) { return handle(e); }
}
