import { erc20Abi } from "@/lib/abis";
import { deployment, isAddress, publicClient, relayerClient } from "@/lib/server/chain";
import { handle } from "@/lib/server/roles";

/// Demo 專用：發 100,000 mTWD。正式環境結算幣由金融機構入金。
export async function POST(req: Request) {
  const { account } = (await req.json()) as { account?: string };
  if (!isAddress(account)) return Response.json({ error: "account" }, { status: 400 });
  try {
  const hash = await relayerClient.writeContract({ address: deployment().settlementToken, abi: erc20Abi, functionName: "mint", args: [account, 100_000n * 10n ** 6n] });
  await publicClient.waitForTransactionReceipt({ hash });
  return Response.json({ txHash: hash });
  } catch (e) { return handle(e); }
}
