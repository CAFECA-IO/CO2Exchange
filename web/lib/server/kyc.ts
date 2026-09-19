import "server-only";
import { keccak256, toBytes, toHex, type Address, type Hex } from "viem";
import { kycRegistryAbi } from "@/lib/abis";
import { deployment, identityVerifier, publicClient, relayerClient } from "./chain";
import { TIER } from "@/lib/deployment";

export type KycRequest = {
  id: string; createdAt: string; updatedAt: string;
  account: Address; tier: number; idNumber: string; name: string; email: string;
  status: "pending" | "approved" | "rejected"; reason?: string; txHash?: Hex; identityHash?: Hex; decidedBy?: string;
};

export function validateId(tier: number, idNumber: string) {
  const idn = idNumber.trim().toUpperCase();
  const ok = tier === TIER.Individual ? /^[A-Z][12]\d{8}$/.test(idn) : /^\d{8}$/.test(idn);
  if (!ok) throw new Error(tier === TIER.Individual ? "身分證字號格式不符" : "統一編號格式不符");
  return idn;
}

export function identityHashOf(tier: number, idn: string): Hex {
  const salt = process.env.IDENTITY_SALT ?? "co2exchange-phase0";
  return keccak256(toBytes(`${tier === TIER.Individual ? "TW-ID" : "TW-UBN"}:${idn}:${salt}`));
}

/// 身分驗證服務簽發 attestation 並由 relayer 送出 register()。
/// 正式環境：這一步之前要驗證工商憑證 / 自然人憑證 / TW FidO 對 account 的簽章與憑證鏈。
export async function attestAndRegister(account: Address, tier: number, idn: string) {
  const d = deployment();
  const identityHash = identityHashOf(tier, idn);
  const nonce = await publicClient.readContract({ address: d.kycRegistry, abi: kycRegistryAbi, functionName: "nonces", args: [account] });
  const now = Math.floor(Date.now() / 1000);
  const attestation = {
    account, tier, expiry: BigInt(now + 365 * 86400), jurisdiction: toHex("TW") as Hex, identityHash, nonce, deadline: BigInt(now + 3600),
  };
  const signature = await identityVerifier.signTypedData({
    domain: { name: "CO2Exchange KYCRegistry", version: "1", chainId: d.chainId, verifyingContract: d.kycRegistry },
    types: { IdentityAttestation: [
      { name: "account", type: "address" }, { name: "tier", type: "uint8" }, { name: "expiry", type: "uint64" },
      { name: "jurisdiction", type: "bytes2" }, { name: "identityHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" } ] },
    primaryType: "IdentityAttestation", message: attestation,
  });
  const hash = await relayerClient.writeContract({ address: d.kycRegistry, abi: kycRegistryAbi, functionName: "register", args: [attestation, signature] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("register reverted");
  return { txHash: hash, identityHash };
}
