import { ApiError, handleError, ok } from "@/lib/server/api";
import { publicEpochFile } from "@/lib/server/ledger/proofs";

/// 一期的公開檔：承諾、每一筆事件的雜湊（可重算 logRoot）、登錄簿層事件全文與包含證據、
/// 登錄簿狀態與葉子（可重算 registryRoot）、逐批次總量表。不含任何個人資料。
export async function GET(_req: Request, ctx: RouteContext<"/api/public/epochs/[epoch]">) {
  try {
    const { epoch } = await ctx.params;
    if (!/^\d{1,12}$/.test(epoch)) throw new ApiError("INVALID_PARAM", "epoch 要是正整數", { param: "epoch" });
    return ok(await publicEpochFile(BigInt(epoch)));
  } catch (e) { return handleError(e); }
}
