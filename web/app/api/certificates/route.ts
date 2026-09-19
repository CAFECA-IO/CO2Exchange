import { parseAbiItem, type Address } from "viem";
import { certificateAbi } from "@/lib/abis";
import { deployment, isAddress, publicClient } from "@/lib/server/chain";
import { handle } from "@/lib/server/roles";

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account");
  if (!isAddress(account)) return Response.json({ error: "account" }, { status: 400 });
  try {
  const d = deployment();
  const logs = await publicClient.getLogs({
    address: d.retirementCertificate,
    event: parseAbiItem("event Retired(uint256 indexed certId, uint256 indexed batchId, address indexed retiredBy, address owner, uint256 amountKg, bytes32 beneficiaryHash, uint8 purpose)"),
    fromBlock: 0n,
  });
  const mine = logs.filter((l) => (l.args.owner as Address).toLowerCase() === account.toLowerCase());
  const certs = await Promise.all(mine.map(async (l) => {
    const c = await publicClient.readContract({ address: d.retirementCertificate, abi: certificateAbi, functionName: "certificateOf", args: [l.args.certId!] });
    return {
      certId: Number(l.args.certId), batchId: Number(c.batchId), amountKg: Number(c.amountKg), beneficiary: c.beneficiary,
      purpose: c.purpose, memo: c.memo, retiredBy: c.retiredBy, retiredAt: Number(c.retiredAt), documentHash: c.documentHash,
      txHash: l.transactionHash, beneficiaryHash: c.beneficiaryHash,
    };
  }));
  return Response.json({ certificates: certs.sort((a, b) => b.certId - a.certId) });
  } catch (e) { return handle(e); }
}
