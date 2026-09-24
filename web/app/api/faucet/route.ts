import { erc20Abi } from "@/lib/abis";
import { deployment, isAddress, publicClient, relayerClient } from "@/lib/server/chain";
import { fail, handleError, ok } from "@/lib/server/api";

/// Demo 專用：發 100,000 mTWD。正式環境結算幣由金融機構入金。
export async function POST(req: Request) {
  try {
    const { account } = (await req.json()) as { account?: string };
    if (!isAddress(account)) return fail("INVALID_ADDRESS", { details: { param: "account" } });
    const hash = await relayerClient.writeContract({
      address: deployment().settlementToken, abi: erc20Abi, functionName: "mint",
      args: [account, 100_000n * 10n ** 6n],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return ok({ txHash: hash });
  } catch (e) { return handleError(e); }
}
