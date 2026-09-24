// @api-envelope-exempt: 回傳的是檔案本體（PDF／二進位），不是 JSON。
// 錯誤仍然走 handleError，所以失敗時的形狀與其他 API 一致。
import { readUpload } from "@/lib/server/store";
import { requireRole } from "@/lib/server/roles";
import { handleError } from "@/lib/server/api";

/// 查驗報告下載（登入者皆可讀：報告 hash 已上鏈，內容本就供稽核）
export async function GET(_req: Request, ctx: RouteContext<"/api/uploads/[name]">) {
  try {
    await requireRole("user");
    const { name } = await ctx.params;
    const buf = readUpload(name);
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
        "content-disposition": `inline; filename="${name}"`,
      },
    });
  } catch (e) { return handleError(e); }
}
