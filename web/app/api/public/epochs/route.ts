import { handleError, ok } from "@/lib/server/api";
import { publicEpochList } from "@/lib/server/ledger/proofs";

/// 公開層（設計 v4 §六）：已上鏈的每一期。不需要登入——這些東西本來就能從鏈上讀到。
export async function GET() {
  try {
    return ok({ epochs: await publicEpochList() });
  } catch (e) { return handleError(e); }
}
