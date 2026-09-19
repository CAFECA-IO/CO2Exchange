import { find, patch } from "@/lib/server/store";
import { signAndIssue, type IssuanceRequest } from "@/lib/server/issuance";
import { handle, requireRole } from "@/lib/server/roles";

/// POST { approve, reason? }（查驗機構）→ 核發：簽 IssuanceAttestation → registry.issue → 1155 批次到專案擁有者
export async function POST(req: Request, ctx: RouteContext<"/api/issuance/[id]">) {
  try {
    const m = await requireRole("verifier");
    const { id } = await ctx.params;
    const { approve, reason } = (await req.json()) as { approve: boolean; reason?: string };
    const row = find<IssuanceRequest>("issuance-requests", id);
    if (!row) throw new Error("申請不存在");
    if (row.status !== "pending") throw new Error("已處理過");
    if (!approve) return Response.json(patch<IssuanceRequest>("issuance-requests", id, { status: "rejected", reason: reason ?? "", decidedBy: m.email }));
    const r = await signAndIssue(row);
    return Response.json(patch<IssuanceRequest>("issuance-requests", id, { status: "issued", batchId: r.batchId, txHash: r.txHash, serialHash: r.serialHash, decidedBy: m.email }));
  } catch (e) { return handle(e); }
}
