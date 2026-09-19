import { all } from "@/lib/server/store";
import type { KycRequest } from "@/lib/server/kyc";
import { handle, requireRole } from "@/lib/server/roles";

export async function GET(req: Request) {
  try {
    await requireRole("admin");
    const status = new URL(req.url).searchParams.get("status");
    const rows = all<KycRequest>("kyc-requests").filter((r) => !status || r.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({ ...r, idNumberMasked: r.idNumber.slice(0, 3) + "****" + r.idNumber.slice(-2) }));
    return Response.json({ requests: rows });
  } catch (e) { return handle(e); }
}
