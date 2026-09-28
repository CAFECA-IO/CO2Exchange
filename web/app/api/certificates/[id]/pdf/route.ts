// @api-envelope-exempt: GET 回傳的是 PDF 本體，不是 JSON。錯誤仍走 fail()／handleError。
import { certData } from "@/lib/server/certs";
import { ledgerCertificateOwner } from "@/lib/server/ledger/registry";
import { existingPdf, generateCertificatePdf } from "@/lib/server/certpdf";
import { me, requireRole } from "@/lib/server/roles";
import { fail, handleError, ok } from "@/lib/server/api";

/// GET → 下載已產生的 PDF（憑證持有人或管理員）
export async function GET(_req: Request, ctx: RouteContext<"/api/certificates/[id]/pdf">) {
  try {
    const m = await me();
    if (!m) return fail("UNAUTHENTICATED");
    const { id } = await ctx.params;
    // 憑證內容本身在登錄簿層是公開的（分層公開），但 PDF 是發給持有人的文件：
    // 只給憑證持有人與管理員。第三方要查真偽，拿持有人給的 PDF 對帳本裡的文件雜湊。
    const owner = ledgerCertificateOwner(Number(id));
    if (!m.isAdmin && owner.toLowerCase() !== m.address.toLowerCase()) return fail("FORBIDDEN");
    const pdf = existingPdf(Number(id));
    if (!pdf) return fail("DOCUMENT_NOT_READY");
    return new Response(new Uint8Array(pdf.buf), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="certificate-${id}.pdf"`, "x-sha256": pdf.sha256 } });
  } catch (e) { return handleError(e); }
}

/// POST → 產生 PDF（管理員）。已鏈上回寫者不可重新產生。
export async function POST(_req: Request, ctx: RouteContext<"/api/certificates/[id]/pdf">) {
  try {
    await requireRole("admin");
    const { id } = await ctx.params;
    const data = await certData(Number(id));
    const r = await generateCertificatePdf(data);
    return ok({ certId: Number(id), sha256: r.sha256, bytes: r.bytes.length });
  } catch (e) { return handleError(e); }
}
