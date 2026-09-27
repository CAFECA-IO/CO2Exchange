import { me } from "@/lib/server/roles";
import { handleError, ok } from "@/lib/server/api";

/// 目前登入者是誰、有沒有管理員／查驗機構權限。
/// 沒登入不是錯誤——訪客本來就看得到公開頁，所以回一個「空的我」而不是 401。
export async function GET() {
  try {
    const m = await me();
    // 只回畫面需要的那幾樣。session 裡還有 kycLevel 與 recoveryPending，
    // 但錢包狀態由 /api/account 回答——同一份資料放兩處，遲早會有一處是舊的。
    return ok(m
      ? { address: m.address, handle: m.handle, isAdmin: m.isAdmin, isVerifier: m.isVerifier }
      : { address: null, handle: null, isAdmin: false, isVerifier: false });
  } catch (e) { return handleError(e); }
}
