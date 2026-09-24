import { me } from "@/lib/server/roles";
import { handleError, ok } from "@/lib/server/api";

/// 目前登入者是誰、有沒有管理員／查驗機構權限。
/// 沒登入不是錯誤——訪客本來就看得到公開頁，所以回一個「空的我」而不是 401。
export async function GET() {
  try {
    return ok((await me()) ?? { email: null, isAdmin: false, isVerifier: false });
  } catch (e) { return handleError(e); }
}
