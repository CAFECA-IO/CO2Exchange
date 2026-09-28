import { isAddress } from "@/lib/server/chain";
import { requireRole } from "@/lib/server/roles";
import { ApiError, handleError, ok } from "@/lib/server/api";
import { confirmDeposit, confirmWithdrawal, rejectWithdrawal, trustAccount, withdrawQueue, type FiatDepositNotice } from "@/lib/server/ledger/fiat";
import { IS_LOCAL_CHAIN, deployment } from "@/lib/server/chain";
import { all } from "@/lib/server/store";

/// 新台幣入出金的營運面。只有管理員。
///
/// 入金確認與出金確認是**營運 Safe** 的鏈上交易。外部鏈上這支 API 不送交易，只回傳要執行的內容
/// 與 `npm run fiat` 指令，由持有人在自己的機器上簽；本機鏈（持有人金鑰是公開的測試金鑰）才直接代送。
/// 退回出金請求是帳本裡的營運授權事件（門檻大於 1 或本站金鑰不在清單上時變成提案）。

export async function GET() {
  try {
    await requireRole("admin");
    const d = deployment();
    return ok({
      executesDirectly: IS_LOCAL_CHAIN,
      operatorSafe: d.operatorSafe,
      ledger: d.ledger,
      token: d.settlementToken,
      trust: trustAccount(),
      withdrawals: await withdrawQueue(),
      recentDeposits: all<FiatDepositNotice>("fiat-deposits").slice(-20).reverse(),
    });
  } catch (e) { return handleError(e); }
}

/// POST { op: "deposit", who, amount, bankRef }       who = 地址或入金識別碼；amount 為最小單位
/// POST { op: "settle", account, amount, bankRef }
/// POST { op: "reject", account, amount, reason }
export async function POST(req: Request) {
  try {
    const m = await requireRole("admin");
    const b = (await req.json()) as Record<string, string>;
    const ref = String(b.bankRef ?? "").trim();
    switch (b.op) {
      case "deposit":
        if (!ref) throw new ApiError("MISSING_PARAM", "要填銀行交易參考號（對帳單上的那一筆）", { param: "bankRef" });
        return ok(await confirmDeposit(String(b.who ?? ""), b.amount, ref, m.address));
      case "settle":
        if (!isAddress(b.account)) throw new ApiError("INVALID_ADDRESS", undefined, { param: "account" });
        if (!ref) throw new ApiError("MISSING_PARAM", "要填匯款的交易參考號", { param: "bankRef" });
        return ok(await confirmWithdrawal(b.account, b.amount, ref));
      case "reject":
        if (!isAddress(b.account)) throw new ApiError("INVALID_ADDRESS", undefined, { param: "account" });
        return ok(await rejectWithdrawal(b.account, b.amount, String(b.reason ?? ""), m.address));
      default:
        throw new ApiError("UNSUPPORTED_ACTION", undefined, { op: b.op });
    }
  } catch (e) { return handleError(e); }
}
