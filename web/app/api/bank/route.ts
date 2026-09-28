import { bankAbi } from "@/lib/abis";
import { publicClient } from "@/lib/server/chain";
import { bankAddress } from "@/lib/server/bank/ledger";
import { handleError, ok } from "@/lib/server/api";
import { deployment } from "@/lib/server/chain";
import { isLedgerV2 } from "@/lib/deployment";
import { LEDGER_ABI } from "@/lib/ledger/chain";
import { ledgerCirculatingKg } from "@/lib/server/ledger/read";

/// 設計 v4：帳本合約。碳權不在鏈上，所以碳權那一列比的是「餘額樹總額」vs「登錄簿流通量」
/// （核發 − 註銷，由帳本算）——兩者應該相等，由重播保證；結算幣那一列照舊是鏈上持有。
async function ledgerSolvency(ledger: `0x${string}`) {
  const [head, epoch, solv, withdrawalsEnabled, escapeIn] = await Promise.all([
    publicClient.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "head" }),
    publicClient.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "epoch" }),
    publicClient.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "solvency" }),
    publicClient.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "withdrawalsEnabled" }),
    publicClient.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "escapeIn" }),
  ]);
  const [owedCash, heldCash, , committedAt] = solv;
  const c = epoch > 0n ? await publicClient.readContract({
    address: ledger, abi: [{ type: "function", name: "commitmentOf", stateMutability: "view", inputs: [{ name: "e", type: "uint64" }], outputs: [{ name: "", type: "tuple", components: [
      { name: "logRoot", type: "bytes32" }, { name: "balanceRoot", type: "bytes32" }, { name: "registryRoot", type: "bytes32" }, { name: "identityRoot", type: "bytes32" },
      { name: "totalKg", type: "uint256" }, { name: "totalCash", type: "uint256" }, { name: "totalsHash", type: "bytes32" }, { name: "upToBlock", type: "uint64" },
      { name: "lastSeq", type: "uint64" }, { name: "rulesVersion", type: "uint16" }, { name: "committedAt", type: "uint64" },
    ] }] }] as const,
    functionName: "commitmentOf", args: [epoch],
  }) : null;
  const owedKg = c?.totalKg ?? 0n;
  const heldKg = ledgerCirculatingKg();
  return {
    mode: "ledger" as const,
    address: ledger, epoch, head, withdrawalsEnabled,
    escape: { active: epoch > 0n && escapeIn === 0n, inSeconds: escapeIn > 10n ** 18n ? null : escapeIn },
    commitment: c ? { ...c, orderLogRoot: c.logRoot } : null,
    committedAt,
    solvency: { owedKg, heldKg, owedCash, heldCash, surplusKg: heldKg - owedKg, surplusCash: heldCash - owedCash },
  };
}

/// 資產池的公開狀態：目前的 epoch、承諾、以及償付能力。
///
/// 不需要登入——這正是重點。「交易所欠使用者多少、池子裡實際有多少」
/// 如果只有登入的人看得到，它就不是揭露，是客服頁面。
export async function GET() {
  try {
    const d = deployment();
    if (isLedgerV2(d)) return ok(await ledgerSolvency(d.ledger));
    const bank = bankAddress();
    const [head, epoch, solvency, withdrawalsEnabled, escapeActive, escapeIn] = await Promise.all([
      publicClient.readContract({ address: bank, abi: bankAbi, functionName: "head" }),
      publicClient.readContract({ address: bank, abi: bankAbi, functionName: "epoch" }),
      publicClient.readContract({ address: bank, abi: bankAbi, functionName: "solvency" }),
      publicClient.readContract({ address: bank, abi: bankAbi, functionName: "withdrawalsEnabled" }),
      publicClient.readContract({ address: bank, abi: bankAbi, functionName: "escapeActive" }),
      publicClient.readContract({ address: bank, abi: bankAbi, functionName: "escapeIn" }),
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
      /// 逃生模式：營運方超過 72 小時沒有提交承諾，使用者不必等誰同意就能提領。
      /// 沒有任何角色關得掉它——這是商業託管這個法律性質下，「拿得回來」唯一的靠山。
      escape: { active: escapeActive, inSeconds: escapeIn > 10n ** 18n ? null : escapeIn },
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
