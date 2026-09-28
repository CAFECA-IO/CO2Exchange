import { find, patch } from "@/lib/server/store";
import { attestAndRegister, idNumberOf, purgeIdNumber, type KycRequest } from "@/lib/server/kyc";
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
    // 審核完證號就刪掉（核准只需要它的雜湊）。回應也不帶任何個人資料欄位
    const strip = ({ idNumberSealed: _a, nameSealed: _b, idNumber: _c, name: _d, ...rest }: KycRequest) => { void _a; void _b; void _c; void _d; return rest; };
    if (!approve) return ok(strip(patch<KycRequest>("kyc-requests", id, { status: "rejected", reason: reason ?? "", decidedBy: m.address, ...purgeIdNumber })));
    const r = await attestAndRegister(row.account, row.tier, idNumberOf(row));
    return ok(strip(patch<KycRequest>("kyc-requests", id, { status: "approved", txHash: r.txHash, identityHash: r.identityHash, decidedBy: m.address, ...purgeIdNumber })));
  } catch (e) { return handleError(e); }
}
