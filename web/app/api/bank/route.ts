import { erc20Abi } from "@/lib/abis";
import { deployment, publicClient } from "@/lib/server/chain";
import { handleError, ok } from "@/lib/server/api";
import { LEDGER_ABI } from "@/lib/ledger/chain";
import { ledgerCirculatingKg } from "@/lib/server/ledger/read";

/// 帳本合約的償付能力。碳權不在鏈上，所以碳權那一列比的是「餘額樹總額」vs「登錄簿流通量」
/// （核發 − 註銷，由帳本算）——兩者應該相等，由重播保證；新台幣那一列是鏈上記帳 TWD（＝營運方宣稱的信託餘額）。
async function ledgerSolvency(ledger: `0x${string}`) {
  const [head, epoch, solv, supply] = await Promise.all([
    publicClient.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "head" }),
    publicClient.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "epoch" }),
    publicClient.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "solvency" }),
    publicClient.readContract({ address: deployment().settlementToken, abi: erc20Abi, functionName: "totalSupply" }),
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
    address: ledger, token: deployment().settlementToken, epoch, head,
    /// 鏈上記帳 TWD 的總發行量。不可轉讓、只鑄給帳本合約，所以應該等於 heldCash
    tokenSupply: supply,
    commitment: c ? { ...c, orderLogRoot: c.logRoot } : null,
    committedAt,
    solvency: { owedKg, heldKg, owedCash, heldCash, surplusKg: heldKg - owedKg, surplusCash: heldCash - owedCash },
  };
}

/// 帳本合約的公開狀態：目前的 epoch、承諾、以及償付能力。
///
/// 不需要登入——這正是重點。「交易所欠使用者多少、信託裡宣稱有多少」
/// 如果只有登入的人看得到，它就不是揭露，是客服頁面。
///
/// 新台幣在信託專戶；鏈上沒有任何人領得走的東西。這裡揭露的是審計數據：帳本宣稱欠多少、
/// 鏈上記帳 TWD（營運方宣稱的信託餘額）多少，兩者並列。
export async function GET() {
  try {
    return ok(await ledgerSolvency(deployment().ledger));
  } catch (e) { return handleError(e); }
}
