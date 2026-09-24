import { bankAbi } from "@/lib/abis";
import { publicClient } from "@/lib/server/chain";
import { bankAddress } from "@/lib/server/bank/ledger";
import { handleError, ok } from "@/lib/server/api";

/// 資產池的公開狀態：目前的 epoch、承諾、以及償付能力。
///
/// 不需要登入——這正是重點。「交易所欠使用者多少、池子裡實際有多少」
/// 如果只有登入的人看得到，它就不是揭露，是客服頁面。
export async function GET() {
  try {
    const bank = bankAddress();
    const [head, epoch, solvency, withdrawalsEnabled] = await Promise.all([
      publicClient.readContract({ address: bank, abi: bankAbi, functionName: "head" }),
      publicClient.readContract({ address: bank, abi: bankAbi, functionName: "epoch" }),
      publicClient.readContract({ address: bank, abi: bankAbi, functionName: "solvency" }),
      publicClient.readContract({ address: bank, abi: bankAbi, functionName: "withdrawalsEnabled" }),
    ]);
    const c = epoch > 0n
      ? await publicClient.readContract({ address: bank, abi: bankAbi, functionName: "commitments", args: [epoch] })
      : null;
    // 具名解構，不要用 c[5]：ABI 中間插一個欄位，索引就全部錯位，
    // 而且**不會報錯**——它只是把 upToBlock 當成 committedAt 顯示出來。
    // （這個錯誤在寫這一支的時候真的發生了。）
    const [owedKg, heldKg, owedCash, heldCash] = solvency;

    return ok({
      address: bank,
      epoch,
      head,
      withdrawalsEnabled,
      commitment: c
        ? {
            orderLogRoot: c[0], balanceRoot: c[1], totalKg: c[2], totalCash: c[3],
            totalsHash: c[4], upToBlock: c[5], lastSeq: c[6], committedAt: c[7],
          }
        : null,
      solvency: {
        owedKg, heldKg, owedCash, heldCash,
        // 差額為正＝池子裡比帳本宣稱的多（多半是還沒入帳的存入）；為負＝合約會擋，不該出現。
        surplusKg: heldKg - owedKg,
        surplusCash: heldCash - owedCash,
      },
    });
  } catch (e) { return handleError(e); }
}
