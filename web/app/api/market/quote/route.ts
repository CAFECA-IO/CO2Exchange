import { quoteMarket } from "@/lib/server/market";
import { isAddress } from "@/lib/server/chain";
import { fail, handleError, ok } from "@/lib/server/api";

/// 市價的實際成本。前端在使用者輸入數量時問這裡，不要自己用現貨價乘一乘——
/// 池子是曲線，成交價是沿路的平均價，薄的時候跟現貨差很遠。
export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const account = u.searchParams.get("account");
    const kg = BigInt(u.searchParams.get("kg") ?? "0");
    const side = u.searchParams.get("side") === "sell" ? "sell" : "buy";
    if (!isAddress(account)) return fail("INVALID_ADDRESS", { details: { param: "account" } });
    if (kg <= 0n) return fail("INVALID_PARAM", { message: "數量要大於 0", details: { param: "kg" } });
    // 報不出價是正常回應，不是錯誤：前端要據此把按鈕關掉並**說對原因**。
    // reason 一定要帶回去——「報不出價」有好幾種原因，猜錯了給的指引就是錯的。
    return ok(await quoteMarket(account, kg, side));
  } catch (e) {
    return handleError(e);
  }
}
