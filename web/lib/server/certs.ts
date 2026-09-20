import "server-only";
import { parseAbiItem, type Address, type Hex } from "viem";
import { certificateAbi, creditAbi, registryAbi } from "@/lib/abis";
import { deployment, publicClient } from "./chain";
import type { CertData } from "./certpdf";

const retiredEvent = parseAbiItem("event Retired(uint256 indexed certId, uint256 indexed batchId, address indexed retiredBy, address owner, uint256 amountKg, bytes32 beneficiaryHash, uint8 purpose, bytes2 country)");

export async function retiredLogs() {
  return publicClient.getLogs({ address: deployment().retirementCertificate, event: retiredEvent, fromBlock: 0n });
}

export async function certData(certId: number): Promise<CertData> {
  const d = deployment();
  const logs = await retiredLogs();
  const log = logs.find((l) => Number(l.args.certId) === certId);
  if (!log) throw new Error("憑證不存在");
  const c = await publicClient.readContract({ address: d.retirementCertificate, abi: certificateAbi, functionName: "certificateOf", args: [BigInt(certId)] });
  const b = await publicClient.readContract({ address: d.carbonCredit1155, abi: creditAbi, functionName: "batchOf", args: [c.batchId] });
  const p = await publicClient.readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "projectOf", args: [b.projectId] });
  return {
    certId, chainId: d.chainId, certificateContract: d.retirementCertificate, batchId: Number(c.batchId), amountKg: Number(c.amountKg),
    beneficiary: c.beneficiary, beneficiaryHash: c.beneficiaryHash, purpose: c.purpose, memo: c.memo, retiredBy: c.retiredBy, retiredAt: Number(c.retiredAt),
    txHash: log.transactionHash as Hex, owner: log.args.owner as Address,
    project: { id: Number(b.projectId), name: p.name, methodology: p.methodology, location: p.location },
    vintageYear: b.vintageYear, monitoringStart: Number(b.monitoringStart), monitoringEnd: Number(b.monitoringEnd),
    verifier: b.verifier, serialHash: b.serialHash, reportHash: b.reportHash,
  };
}
