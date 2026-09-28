import { handleError, ok } from "@/lib/server/api";
import { requireRole } from "@/lib/server/roles";
import { proofFileOf } from "@/lib/server/ledger/proofs";

/// 我的證明檔（設計 v4 第 6 期）：最新一期的託管持有、每一批額度、身分，以及我自己的事件的包含證據。
///
/// 格式照 Boltchain Issue #1：拿去 Explorer 上傳、或用 `node scripts/verify-proof.mjs` 對任一節點驗，
/// 都不需要本站。只給本人——裡面有他的持有與事件內容；兄弟節點只是雜湊，不含其他人的資料。
export async function GET() {
  try {
    const m = await requireRole("user");
    return ok(await proofFileOf(m.address));
  } catch (e) { return handleError(e); }
}
