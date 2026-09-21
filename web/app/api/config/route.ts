import { deployment } from "@/lib/server/chain";
import { providerIds } from "@/auth";

/// 前端啟動需要知道的兩件事：合約地址表，以及有哪些登入方式。
///
/// **這裡不再給 RPC 位址。** 以前會回 `rpcUrl`，瀏覽器拿它自己開一條連線去讀鏈；
/// 現在所有鏈上讀寫都經過 /api/*。少掉那一行的實際差別：
///   · 節點位址不必發給每一個訪客——它原本等於被公開，任何人都能拿它發請求，
///     也把節點的存在與位置洩漏出去。
///   · 不會出現「瀏覽器讀到一條鏈、伺服器讀到另一條」：內網節點、IP 白名單、
///     公司防火牆之下，兩邊看到的根本不是同一份狀態。
///   · 合約 ABI 只留在伺服器端，改版時不必擔心某個瀏覽器還快取著舊的那一份。
export async function GET() {
  return Response.json({ deployment: deployment(), providers: providerIds });
}
