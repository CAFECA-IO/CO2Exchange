import { custody } from "@/lib/server/reserve";
import { handle } from "@/lib/server/roles";

/// 託管揭露是公開資訊：不需要登入。
export async function GET() {
  try {
    return Response.json(await custody());
  } catch (e) { return handle(e); }
}
