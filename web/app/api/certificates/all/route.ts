import { existingPdf } from "@/lib/server/certpdf";
import { requireRole } from "@/lib/server/roles";
import { handleError, ok } from "@/lib/server/api";
import { ledgerCertificates } from "@/lib/server/ledger/registry";

/// 管理員：所有憑證 + PDF / 錨定狀態
export async function GET() {
  try {
    await requireRole("admin");
    return ok({ certificates: ledgerCertificates().map((c) => {
      const pdf = existingPdf(c.certId);
      const onchainHash = /^0x0+$/.test(c.documentHash) ? null : c.documentHash;
      return {
        certId: c.certId, batchId: c.batchId, amountKg: c.amountKg, beneficiary: c.beneficiary, purpose: c.purpose, retiredAt: c.retiredAt,
        owner: c.owner, pdfHash: pdf?.sha256 ?? null, onchainHash, anchored: !!pdf && !!onchainHash && pdf.sha256.toLowerCase() === onchainHash.toLowerCase(),
      };
    }) });
  } catch (e) { return handleError(e); }
}
