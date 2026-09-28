import { isAddress } from "@/lib/server/chain";
import { holdings, listBids, listOrders } from "@/lib/server/market";
import { handleError, ok } from "@/lib/server/api";
import { ledgerTradeFeeBps } from "@/lib/server/ledger/read";

export async function GET(req: Request) {
  try {
    const account = new URL(req.url).searchParams.get("account");
    const [orders, bids] = await Promise.all([listOrders(), listBids()]);
    const h = isAddress(account) ? await holdings(account) : null;
    return ok({ orders, bids, listingFeeBps: ledgerTradeFeeBps(), holdings: h });
  } catch (e) {
    return handleError(e);
  }
}
