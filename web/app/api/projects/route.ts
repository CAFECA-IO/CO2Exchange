import { isAddress } from "@/lib/server/chain";
import { handleError, ok } from "@/lib/server/api";
import { ledgerProjects } from "@/lib/server/ledger/registry";

/// GET [?owner=] → 專案清單（帳本）
export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner");
  try {
    return ok({ projects: ledgerProjects(isAddress(owner) ? owner : null) });
  } catch (e) { return handleError(e); }
}
