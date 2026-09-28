import { handleError, ok } from "@/lib/server/api";
import { disclosure } from "@/lib/server/mm";

/// 平台做市與模擬交易的公開揭露。免登入：市場參與者有權知道對手裡哪些是平台自己。
export async function GET() {
  try { return ok(disclosure()); } catch (e) { return handleError(e); }
}
