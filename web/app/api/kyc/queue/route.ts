import { all } from "@/lib/server/store";
import { nameOf, type KycRequest } from "@/lib/server/kyc";
import { maskIdNumber } from "@/lib/crypto/sealed";
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
      // 密文欄位也一樣拔掉：瀏覽器不需要它，姓名由伺服器解開給管理員看
      .map((r) => {
        const { idNumber, idNumberSealed: _s, nameSealed: _n, name: _m, ...rest } = r; void _s; void _n; void _m;
        return { ...rest, name: nameOf(r), idNumberMasked: r.idNumberMasked ?? (idNumber ? maskIdNumber(idNumber) : "—") };
      });
    return ok({ requests: rows });
  } catch (e) { return handleError(e); }
}
