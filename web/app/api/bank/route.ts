import { deployment, publicClient } from "@/lib/server/chain";
import { handleError, ok } from "@/lib/server/api";
import { LEDGER_ABI } from "@/lib/ledger/chain";
import { ledgerCirculatingKg } from "@/lib/server/ledger/read";

/// 帳本合約的償付能力。碳權不在鏈上，所以碳權那一列比的是「餘額樹總額」vs「登錄簿流通量」
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

/// 帳本合約的公開狀態：目前的 epoch、承諾、以及償付能力。
///
/// 不需要登入——這正是重點。「交易所欠使用者多少、池子裡實際有多少」
/// 如果只有登入的人看得到，它就不是揭露，是客服頁面。
///
/// 逃生模式：營運方超過 72 小時沒有提交承諾，使用者不必等誰同意就能憑最新一期的證據提領。
/// 沒有任何角色關得掉它——這是商業託管這個法律性質下，「拿得回來」唯一的靠山。
export async function GET() {
  try {
    return ok(await ledgerSolvency(deployment().ledger));
  } catch (e) { return handleError(e); }
}
