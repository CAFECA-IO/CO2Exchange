import { kycRegistryAbi } from "@/lib/abis";
import { deployment, isAddress, publicClient } from "@/lib/server/chain";
import { TIER } from "@/lib/deployment";
import { all, insert, patch } from "@/lib/server/store";
import { attestAndRegister, validateId, type KycRequest } from "@/lib/server/kyc";
import { handle, requireRole } from "@/lib/server/roles";

/// GET ?account= → 鏈上身分 + 最新申請狀態
export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account");
  if (!isAddress(account)) return Response.json({ error: "account" }, { status: 400 });
  try {
  const id = await publicClient.readContract({ address: deployment().kycRegistry, abi: kycRegistryAbi, functionName: "identityOf", args: [account] });
  const reqs = all<KycRequest>("kyc-requests").filter((r) => r.account.toLowerCase() === account.toLowerCase());
  const latest = reqs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  return Response.json({
    tier: id.tier, expiry: Number(id.expiry), frozen: id.frozen, jurisdiction: id.jurisdiction, identityHash: id.identityHash,
    application: latest ? { id: latest.id, status: latest.status, tier: latest.tier, reason: latest.reason, createdAt: latest.createdAt } : null,
  });
  } catch (e) { return handle(e); }
}

/// POST { account, tier, idNumber, name } → 建立申請。KYC_AUTO_APPROVE=1 時直接簽發（demo / e2e）。
export async function POST(req: Request) {
  try {
    const m = await requireRole("user");
    const body = (await req.json()) as { account?: string; tier?: number; idNumber?: string; name?: string };
    const { account, tier } = body;
    if (!isAddress(account)) throw new Error("account");
    if (tier !== TIER.Individual && tier !== TIER.Corporate) throw new Error("tier");
    const idn = validateId(tier, String(body.idNumber ?? ""));
    const row = insert<KycRequest>("kyc-requests", {
      account, tier, idNumber: idn, name: String(body.name ?? "").slice(0, 100), email: m.email, status: "pending",
    });
    if (process.env.KYC_AUTO_APPROVE === "1") {
      const r = await attestAndRegister(account, tier, idn);
      patch<KycRequest>("kyc-requests", row.id, { status: "approved", txHash: r.txHash, identityHash: r.identityHash, decidedBy: "auto" });
      return Response.json({ id: row.id, status: "approved", txHash: r.txHash, identityHash: r.identityHash });
    }
    return Response.json({ id: row.id, status: "pending" });
  } catch (e) { return handle(e); }
}
