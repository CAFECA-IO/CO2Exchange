import { keccak256, toBytes, toHex, type Hex } from "viem";
import { kycRegistryAbi } from "@/lib/abis";
import { deployment, identityVerifier, isAddress, publicClient, relayerClient } from "@/lib/server/chain";
import { TIER } from "@/lib/deployment";
import { auth } from "@/auth";

/// GET ?account= → 鏈上身分狀態
export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account");
  if (!isAddress(account)) return Response.json({ error: "account" }, { status: 400 });
  const id = await publicClient.readContract({ address: deployment().kycRegistry, abi: kycRegistryAbi, functionName: "identityOf", args: [account] });
  return Response.json({ tier: id.tier, expiry: Number(id.expiry), frozen: id.frozen, jurisdiction: id.jurisdiction, identityHash: id.identityHash });
}

/// POST { account, tier, idNumber, name }
/// Phase 0：這裡「模擬」身分驗證服務 —— 正式環境此處驗證工商憑證 / 自然人憑證 / TW FidO 的簽章與憑證鏈，
/// 通過後才簽發 attestation。鏈上只存 identityHash，不存個資。
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const body = (await req.json()) as { account?: string; tier?: number; idNumber?: string; name?: string };
  const { account, tier, idNumber } = body;
  if (!isAddress(account)) return Response.json({ error: "account" }, { status: 400 });
  if (tier !== TIER.Individual && tier !== TIER.Corporate) return Response.json({ error: "tier" }, { status: 400 });
  const idn = String(idNumber ?? "").trim().toUpperCase();
  const ok = tier === TIER.Individual ? /^[A-Z][12]\d{8}$/.test(idn) : /^\d{8}$/.test(idn);
  if (!ok) return Response.json({ error: tier === TIER.Individual ? "身分證字號格式不符" : "統一編號格式不符" }, { status: 400 });

  const d = deployment();
  const salt = process.env.IDENTITY_SALT ?? "co2exchange-phase0";
  const identityHash = keccak256(toBytes(`${tier === TIER.Individual ? "TW-ID" : "TW-UBN"}:${idn}:${salt}`));
  const nonce = await publicClient.readContract({ address: d.kycRegistry, abi: kycRegistryAbi, functionName: "nonces", args: [account] });
  const now = Math.floor(Date.now() / 1000);
  const attestation = {
    account,
    tier,
    expiry: BigInt(now + 365 * 86400),
    jurisdiction: toHex("TW") as Hex,
    identityHash,
    nonce,
    deadline: BigInt(now + 3600),
  };
  const signature = await identityVerifier.signTypedData({
    domain: { name: "CO2Exchange KYCRegistry", version: "1", chainId: d.chainId, verifyingContract: d.kycRegistry },
    types: {
      IdentityAttestation: [
        { name: "account", type: "address" }, { name: "tier", type: "uint8" }, { name: "expiry", type: "uint64" },
        { name: "jurisdiction", type: "bytes2" }, { name: "identityHash", type: "bytes32" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" } ],
    },
    primaryType: "IdentityAttestation",
    message: attestation,
  });
  const hash = await relayerClient.writeContract({ address: d.kycRegistry, abi: kycRegistryAbi, functionName: "register", args: [attestation, signature] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return Response.json({ txHash: hash, status: receipt.status, identityHash });
}
