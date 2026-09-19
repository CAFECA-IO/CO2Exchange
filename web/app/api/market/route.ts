import { deployment, isAddress } from "@/lib/server/chain";
import { holdings, listOrders, poolKey, poolSpotPricePerTonne } from "@/lib/server/market";
import { listingAbi } from "@/lib/abis";
import { publicClient } from "@/lib/server/chain";

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account");
  const d = deployment();
  const [orders, spot, feeBps] = await Promise.all([
    listOrders(), poolSpotPricePerTonne().catch(() => null),
    publicClient.readContract({ address: d.listing, abi: listingAbi, functionName: "feeBps" }),
  ]);
  const h = isAddress(account) ? await holdings(account) : null;
  return Response.json({ orders, spotPricePerTonne: spot, listingFeeBps: Number(feeBps), poolKey: poolKey(), holdings: h });
}
