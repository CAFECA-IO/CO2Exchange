import { erc20Abi } from "@/lib/abis";
import { deployment, isAddress, publicClient, relayerClient } from "@/lib/server/chain";
import { fail, handleError, ok } from "@/lib/server/api";
import { submit } from "@/lib/server/tx";

/// Demo 專用：發 100,000 mTWD。
///
/// **只有在結算幣是本站自己發的 MockTWD 時才成立。** 用外部結算幣時
/// （Boltchain 上是 CAFECA 的 TWDC）本站沒有鑄幣權，這支一定失敗——
/// 與其讓它在鏈上 revert 成一句看不懂的話，不如在這裡就說清楚為什麼。
///
/// 那才是正式的樣子：結算幣由金融機構發行與入金，交易所不該有鑄幣權。
/// 一個能憑空生出結算幣的交易所，它的資產池揭露就沒有意義了。
export async function POST(req: Request) {
  try {
    const d = deployment();
    if (d.settlementMintable !== true) {
      return fail("FORBIDDEN", {
        message: "這條鏈上的結算幣不是本站發行的，沒有鑄幣權。請改由發行方入金。",
      });
    }
    const { account } = (await req.json()) as { account?: string };
    if (!isAddress(account)) return fail("INVALID_ADDRESS", { details: { param: "account" } });
    const { request } = await publicClient.simulateContract({
      address: d.settlementToken, abi: erc20Abi, functionName: "mint",
      args: [account, 100_000n * 10n ** 6n], account: relayerClient.account,
    });
    const { hash } = await submit(request);
    return ok({ txHash: hash });
  } catch (e) { return handleError(e); }
}
