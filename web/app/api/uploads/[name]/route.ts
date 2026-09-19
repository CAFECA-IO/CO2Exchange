import { readUpload } from "@/lib/server/store";
import { handle, requireRole } from "@/lib/server/roles";

/// 查驗報告下載（登入者皆可讀：報告 hash 已上鏈，內容本就供稽核）
export async function GET(_req: Request, ctx: RouteContext<"/api/uploads/[name]">) {
  try {
    await requireRole("user");
    const { name } = await ctx.params;
    const buf = readUpload(name);
    return new Response(new Uint8Array(buf), { headers: { "content-type": name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream", "content-disposition": `inline; filename="${name}"` } });
  } catch (e) { return handle(e); }
}
