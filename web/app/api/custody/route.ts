import { custody } from "@/lib/server/reserve";
import { handleError, ok } from "@/lib/server/api";

/// 託管揭露是公開資訊：不需要登入。
export async function GET() {
  try {
    return ok(await custody());
  } catch (e) { return handleError(e); }
}
