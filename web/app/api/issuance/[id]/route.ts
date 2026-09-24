import { find, patch } from "@/lib/server/store";
import { signAndIssue, type IssuanceRequest } from "@/lib/server/issuance";
import { requireRole } from "@/lib/server/roles";
import { ApiError, handleError, ok } from "@/lib/server/api";

/// POST { approve, reason? }（查驗機構）→ 核發：簽 IssuanceAttestation → registry.issue → 1155 批次到專案擁有者
export async function POST(req: Request, ctx: RouteContext<"/api/issuance/[id]">) {
  try {
    const m = await requireRole("verifier");
    const { id } = await ctx.params;
    const { approve, reason } = (await req.json()) as { approve: boolean; reason?: string };
    const row = find<IssuanceRequest>("issuance-requests", id);
    if (!row) throw new ApiError("NOT_FOUND", "找不到這筆核發申請");
    if (row.status !== "pending") throw new ApiError("ALREADY_EXISTS", "這筆申請已經處理過了");
    if (!approve) return ok(patch<IssuanceRequest>("issuance-requests", id, { status: "rejected", reason: reason ?? "", decidedBy: m.email }));
    const r = await signAndIssue(row);
    return ok(patch<IssuanceRequest>("issuance-requests", id, { status: "issued", batchId: r.batchId, txHash: r.txHash, serialHash: r.serialHash, decidedBy: m.email }));
  } catch (e) { return handleError(e); }
}
