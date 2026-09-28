import { certificateAbi } from "@/lib/abis";
import { deployment, publicClient } from "@/lib/server/chain";
import { retiredLogs } from "@/lib/server/certs";
import { existingPdf } from "@/lib/server/certpdf";
import { requireRole } from "@/lib/server/roles";
import { handleError, ok } from "@/lib/server/api";
import { ledgerEnabled } from "@/lib/server/ledger/view";
import { ledgerCertificates } from "@/lib/server/ledger/registry";

/// 管理員：所有憑證 + PDF / 回寫狀態
export async function GET() {
  try {
    await requireRole("admin");
    if (ledgerEnabled()) {
      return ok({ certificates: ledgerCertificates().map((c) => {
        const pdf = existingPdf(c.certId);
        const onchainHash = /^0x0+$/.test(c.documentHash) ? null : c.documentHash;
        return {
          certId: c.certId, batchId: c.batchId, amountKg: c.amountKg, beneficiary: c.beneficiary, purpose: c.purpose, retiredAt: c.retiredAt,
          owner: c.owner, pdfHash: pdf?.sha256 ?? null, onchainHash, anchored: !!pdf && !!onchainHash && pdf.sha256.toLowerCase() === onchainHash.toLowerCase(),
        };
      }) });
    }
    const d = deployment();
    const logs = await retiredLogs();
    const rows = await Promise.all(logs.map(async (l) => {
      const id = Number(l.args.certId);
      const c = await publicClient.readContract({ address: d.retirementCertificate, abi: certificateAbi, functionName: "certificateOf", args: [BigInt(id)] });
      const pdf = existingPdf(id);
      const onchain = c.documentHash;
      return {
        certId: id, batchId: Number(c.batchId), amountKg: Number(c.amountKg), beneficiary: c.beneficiary, purpose: c.purpose, retiredAt: Number(c.retiredAt),
        owner: l.args.owner, pdfHash: pdf?.sha256 ?? null, onchainHash: /^0x0+$/.test(onchain) ? null : onchain,
        anchored: !!pdf && pdf.sha256.toLowerCase() === onchain.toLowerCase(),
      };
    }));
    return ok({ certificates: rows.sort((a, b) => b.certId - a.certId) });
  } catch (e) { return handleError(e); }
}
