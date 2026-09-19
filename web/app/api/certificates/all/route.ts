import { certificateAbi } from "@/lib/abis";
import { deployment, publicClient } from "@/lib/server/chain";
import { retiredLogs } from "@/lib/server/certs";
import { existingPdf } from "@/lib/server/certpdf";
import { handle, requireRole } from "@/lib/server/roles";

/// 管理員：所有憑證 + PDF / 回寫狀態
export async function GET() {
  try {
    await requireRole("admin");
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
    return Response.json({ certificates: rows.sort((a, b) => b.certId - a.certId) });
  } catch (e) { return handle(e); }
}
