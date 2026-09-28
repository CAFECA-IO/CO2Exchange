import { existingPdf } from "@/lib/server/certpdf";
import { requireRole } from "@/lib/server/roles";
import { ApiError, handleError, ok } from "@/lib/server/api";
import { ledgerAnchorCertificate } from "@/lib/server/ledger/registry";

/// POST → 把 PDF 的 SHA-256 寫進帳本（DOCUMENT_SIGNER 簽的 certDocument 事件）
export async function POST(_req: Request, ctx: RouteContext<"/api/certificates/[id]/anchor">) {
  try {
    await requireRole("admin");
    const { id } = await ctx.params;
    const pdf = existingPdf(Number(id));
    if (!pdf) throw new ApiError("DOCUMENT_NOT_READY", "請先產生 PDF");
    return ok({ certId: Number(id), documentHash: pdf.sha256, ...(await ledgerAnchorCertificate(Number(id), pdf.sha256)) });
  } catch (e) { return handleError(e); }
}
