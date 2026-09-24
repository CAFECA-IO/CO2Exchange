import { find, patch } from "@/lib/server/store";
import { attestAndRegister, type KycRequest } from "@/lib/server/kyc";
import { requireRole } from "@/lib/server/roles";
import { ApiError, handleError, ok } from "@/lib/server/api";

/// POST { id, approve, reason? }（管理員）。核准 = 模擬憑證驗證通過 → 簽 attestation → 上鏈。
export async function POST(req: Request) {
  try {
    const m = await requireRole("admin");
    const { id, approve, reason } = (await req.json()) as { id: string; approve: boolean; reason?: string };
    const row = find<KycRequest>("kyc-requests", id);
    if (!row) throw new ApiError("NOT_FOUND", "找不到這筆身分驗證申請");
    if (row.status !== "pending") throw new ApiError("ALREADY_EXISTS", "這筆申請已經處理過了");
    if (!approve) return ok(patch<KycRequest>("kyc-requests", id, { status: "rejected", reason: reason ?? "", decidedBy: m.email }));
    const r = await attestAndRegister(row.account, row.tier, row.idNumber);
    return ok(patch<KycRequest>("kyc-requests", id, { status: "approved", txHash: r.txHash, identityHash: r.identityHash, decidedBy: m.email }));
  } catch (e) { return handleError(e); }
}
