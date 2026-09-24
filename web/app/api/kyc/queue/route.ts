import { all } from "@/lib/server/store";
import type { KycRequest } from "@/lib/server/kyc";
import { requireRole } from "@/lib/server/roles";
import { handleError, ok } from "@/lib/server/api";

export async function GET(req: Request) {
  try {
    await requireRole("admin");
    const status = new URL(req.url).searchParams.get("status");
    const rows = all<KycRequest>("kyc-requests").filter((r) => !status || r.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      // 先展開 ...r 再「補上」遮罩欄位的話，明文 idNumber 仍然在 response 裡——
      // 遮罩只是裝飾，審核者的瀏覽器、快取與任何攔截到這個請求的人都拿得到全碼。
      // 把原欄位拔掉，只送遮罩過的。畫面本來就只用 idNumberMasked。
      .map(({ idNumber, ...r }) => ({
        ...r,
        idNumberMasked: idNumber.slice(0, 3) + "****" + idNumber.slice(-2),
      }));
    return ok({ requests: rows });
  } catch (e) { return handleError(e); }
}
