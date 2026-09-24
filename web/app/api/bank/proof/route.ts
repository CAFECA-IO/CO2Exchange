import { bankAbi } from "@/lib/abis";
import { isAddress, publicClient } from "@/lib/server/chain";
import { buildBalanceTree } from "@/lib/bank/tree";
import { bankAddress, readLedger } from "@/lib/server/bank/ledger";
import { fail, handleError, ok } from "@/lib/server/api";
import { requireRole } from "@/lib/server/roles";
import { walletOf } from "@/lib/server/wallet";

/// 「你的餘額在第 N 期的樹裡，這是證據。」
///
/// 這一支是「不提供提領，但保留機制」裡**真正有內容**的那一半。提領的合約函式
/// 關著沒關係，但如果使用者拿不到自己的 Merkle 分支，那個機制在營運方消失的那天
/// 就不存在——而那正是它唯一會被用到的時候。所以它現在就要能用。
///
/// 只回自己的那一份：明細只給監理與查核，這是決策。使用者驗得了自己那一筆
/// （root 公開，他自己算得出來），監理方驗得了全部。
export async function GET() {
  try {
    const m = await requireRole("user");
    const wallet = await walletOf(m.email, m.id);
    const account = wallet.address;
    if (!isAddress(account)) return fail("INVALID_ADDRESS", { details: { param: "account" } });

    const bank = bankAddress();
    const epoch = await publicClient.readContract({ address: bank, abi: bankAbi, functionName: "epoch" });
    if (epoch === 0n) return fail("NOT_FOUND", { message: "還沒有任何一期的承諾上鏈" });
    const c = await publicClient.readContract({
      address: bank, abi: bankAbi, functionName: "commitments", args: [epoch],
    });
    const [, balanceRoot, , , , upToBlock] = c;

    // **一定要讀到 upToBlock 為止。** 用「現在」重建的話，這一期承諾之後發生的存入
    // 會被算進去，root 就對不上——而那個錯會長得像「證據壞了」，不像「讀錯區間」。
    const ledger = await readLedger(BigInt(upToBlock));
    if (!ledger.balances.some((b) => b.account.toLowerCase() === account.toLowerCase())) {
      return fail("NOT_FOUND", { message: "這個帳戶在第 " + epoch + " 期的資產池裡沒有餘額" });
    }

    const tree = buildBalanceTree(ledger.balances, epoch);
    if (tree.root.hash !== balanceRoot) {
      // 重建不出鏈上那個 root，就不要發一份驗不過的證據出去。
      // 這個狀況本身是警訊：帳本推導與當初提交的不一致。
      return fail("DATA_STALE", {
        message: "重建出來的餘額樹和鏈上第 " + epoch + " 期的 root 不一致，證據暫時發不出來",
        details: { expected: balanceRoot, computed: tree.root.hash, upToBlock },
      });
    }

    const proof = tree.proofOf(account);
    const assets = ledger.balances.find((b) => b.account.toLowerCase() === account.toLowerCase())!.assets;

    return ok({
      epoch,
      upToBlock,
      root: tree.root.hash,
      totalKg: tree.root.kg,
      totalCash: tree.root.cash,
      leaf: { assetsRoot: proof.assetsRoot, kg: proof.leafKg, cash: proof.leafCash },
      siblings: proof.siblings,
      path: proof.path,
      assets: assets.map((a) => ({ batchId: a.batchId, ...tree.assetProofOf(account, a.batchId) })),
    });
  } catch (e) { return handleError(e); }
}
