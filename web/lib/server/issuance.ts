import "server-only";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { registryWriteAbi } from "@/lib/abis";
import { deployment, publicClient, relayerClient, requireOwnKey } from "./chain";
import { submit } from "./tx";
import { ApiError } from "./api";

export type IssuanceRequest = {
  id: string; createdAt: string; updatedAt: string;
  projectId: number; projectName: string; owner: Address; submittedBy: string;
  monitoringStart: string; monitoringEnd: string; amountKg: number; // ISO 日期
  reportFile: string; reportHash: Hex; reportName: string; note?: string;
  status: "pending" | "issued" | "rejected"; reason?: string; batchId?: number; txHash?: Hex; serialHash?: Hex; decidedBy?: string;
};

// Phase 0：查驗機構的簽章金鑰放在本站（CARBON_VERIFIER_PK，預設 Anvil account0）。
// 正式環境：查驗機構在自己的系統簽 IssuanceAttestation，本站只收簽章並送出 issue()。
export const carbonVerifier = privateKeyToAccount(
  requireOwnKey("CARBON_VERIFIER_PK", process.env.CARBON_VERIFIER_PK ?? process.env.RELAYER_PK) as Hex,
);

export async function signAndIssue(r: IssuanceRequest) {
  const d = deployment();
  const start = BigInt(Math.floor(Date.parse(r.monitoringStart + "T00:00:00Z") / 1000));
  const end = BigInt(Math.floor(Date.parse(r.monitoringEnd + "T23:59:59Z") / 1000));
  // 序號：TW-<projectId>-<start>-<end>-<amount> 的雜湊；正式由登錄簿序號規則產生
  const serial = `TW-P${r.projectId}-${r.monitoringStart}-${r.monitoringEnd}-${r.amountKg}`;
  const serialHash = keccak256(toBytes(serial));
  const attestationId = BigInt(keccak256(toBytes(r.id))) >> 8n;
  const a = { projectId: BigInt(r.projectId), monitoringStart: start, monitoringEnd: end, amountKg: BigInt(r.amountKg), serialHash, reportHash: r.reportHash, attestationId, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) };
  const signature = await carbonVerifier.signTypedData({
    domain: { name: "CO2Exchange CarbonRegistry", version: "1", chainId: d.chainId, verifyingContract: d.carbonRegistry },
    types: { IssuanceAttestation: [
      { name: "projectId", type: "uint256" }, { name: "monitoringStart", type: "uint64" }, { name: "monitoringEnd", type: "uint64" },
      { name: "amountKg", type: "uint256" }, { name: "serialHash", type: "bytes32" }, { name: "reportHash", type: "bytes32" },
      { name: "attestationId", type: "uint256" }, { name: "deadline", type: "uint256" } ] },
    primaryType: "IssuanceAttestation", message: a,
  });
  const { request, result } = await publicClient.simulateContract({ address: d.carbonRegistry, abi: registryWriteAbi, functionName: "issue", args: [a, signature], account: relayerClient.account });
  const { hash, receipt } = await submit(request);
  if (receipt.status !== "success") throw new ApiError("CONTRACT_REVERTED", "核發交易被鏈上拒絕");
  return { txHash: hash, batchId: Number(result), serialHash, serial };
}
