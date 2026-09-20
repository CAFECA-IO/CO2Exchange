import { deployment, isAddress } from "@/lib/server/chain";
import { holdings, listBids, listOrders, poolKey, poolSpotPricePerTonne } from "@/lib/server/market";
import { listingAbi } from "@/lib/abis";
import { publicClient } from "@/lib/server/chain";
import { handle } from "@/lib/server/roles";

export async function GET(req: Request) {
  try {
    const account = new URL(req.url).searchParams.get("account");
    const d = deployment();
    const [orders, bids, spot, feeBps] = await Promise.all([
      listOrders(), listBids(), poolSpotPricePerTonne().catch(() => null),
      publicClient.readContract({ address: d.listing, abi: listingAbi, functionName: "feeBps" }),
    ]);
    const h = isAddress(account) ? await holdings(account) : null;
    return Response.json({ orders, bids, spotPricePerTonne: spot, listingFeeBps: Number(feeBps), poolKey: poolKey(), holdings: h });
  } catch (e) {
    return handle(e);
  }
}
