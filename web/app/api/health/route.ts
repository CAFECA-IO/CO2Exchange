import { fail, handleError, ok } from "@/lib/server/api";
import { ledgerLiveness } from "@/lib/server/ledger/liveness";

/// 給外部監控（UptimeRobot、cron、demo-box）看的健康檢查。不需要登入。
///
/// 只看一件事：**承諾排程有沒有在跑**（判斷規則見 lib/ledger/liveness.ts）。
///   · ok／late → 200，`data.status` 說是哪一種（late 是警告：漏了一兩次排程）
///   · stalled   → 503 LEDGER_STALLED，`details` 是同一份內容——監控服務只看狀態碼就夠
///   · 節點連不上、部署檔對不上 → 503（CHAIN_UNREACHABLE／DEPLOYMENT_MISMATCH），一樣會被看到
export async function GET() {
  try {
    const l = await ledgerLiveness();
    if (l.status === "stalled") return fail("LEDGER_STALLED", { message: l.reason, details: l });
    return ok(l);
  } catch (e) { return handleError(e); }
}
