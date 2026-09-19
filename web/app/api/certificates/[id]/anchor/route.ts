import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { certificateAbi, certificateWriteAbi } from "@/lib/abis";
import { chain, deployment, publicClient, RPC_URL, relayer } from "@/lib/server/chain";
import { existingPdf } from "@/lib/server/certpdf";
import { handle, requireRole } from "@/lib/server/roles";

/// POST → 把 PDF 的 SHA-256 回寫到鏈上 documentHash（DOCUMENT_ROLE 金鑰；Phase 0 = relayer）
export async function POST(_req: Request, ctx: RouteContext<"/api/certificates/[id]/anchor">) {
  try {
    await requireRole("admin");
    const { id } = await ctx.params;
    const pdf = existingPdf(Number(id));
    if (!pdf) throw new Error("請先產生 PDF");
    const d = deployment();
    const current = (await publicClient.readContract({ address: d.retirementCertificate, abi: certificateAbi, functionName: "certificateOf", args: [BigInt(id)] })).documentHash;
    if (!/^0x0+$/.test(current)) throw new Error("鏈上已有 documentHash，不可覆寫");
    const signer = process.env.DOCUMENT_SIGNER_PK ? privateKeyToAccount(process.env.DOCUMENT_SIGNER_PK as Hex) : relayer;
    const wallet = createWalletClient({ chain, account: signer, transport: http(RPC_URL) });
    const { request } = await publicClient.simulateContract({ address: d.retirementCertificate, abi: certificateWriteAbi, functionName: "setDocumentHash", args: [BigInt(id), pdf.sha256], account: signer });
    const hash = await wallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });
    return Response.json({ certId: Number(id), documentHash: pdf.sha256, txHash: hash });
  } catch (e) { return handle(e); }
}
