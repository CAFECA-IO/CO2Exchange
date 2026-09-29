import { handleError, ok } from "@/lib/server/api";
import { publicEpochList } from "@/lib/server/ledger/proofs";
import { ledgerLiveness } from "@/lib/server/ledger/liveness";

/// 公開層（設計 v4 §六）：已上鏈的每一期。不需要登入——這些東西本來就能從鏈上讀到。
export async function GET() {
  try {
    // liveness：承諾排程有沒有在跑。停擺時這一支照樣回 200（清單本身沒錯），監控請看 /api/health
    const [epochs, liveness] = await Promise.all([publicEpochList(), ledgerLiveness()]);
    return ok({ epochs, liveness });
  } catch (e) { return handleError(e); }
}
