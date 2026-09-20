import { quoteMarket } from "@/lib/server/market";
import { isAddress } from "@/lib/server/chain";
import { handle } from "@/lib/server/roles";

/// 市價的實際成本。前端在使用者輸入數量時問這裡，不要自己用現貨價乘一乘——
/// 池子是曲線，成交價是沿路的平均價，薄的時候跟現貨差很遠。
export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const account = u.searchParams.get("account");
    const kg = BigInt(u.searchParams.get("kg") ?? "0");
    const side = u.searchParams.get("side") === "sell" ? "sell" : "buy";
    if (!isAddress(account) || kg <= 0n) return Response.json({ error: "bad request" }, { status: 400 });
    const q = await quoteMarket(account, kg, side);
    // 報不出價＝流動性不足（或這個帳戶過不了身分檢查）。這是正常回應，不是錯誤：
    // 前端要據此把按鈕關掉並說明原因，而不是讓使用者送出去撞 revert。
    return Response.json(q ?? { unavailable: true });
  } catch (e) {
    return handle(e);
  }
}
