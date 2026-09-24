import { all, insert } from "@/lib/server/store";
import type { WithId } from "@/lib/server/store";
import { fail, handleError, ok } from "@/lib/server/api";
import { isAddress } from "@/lib/server/chain";
import { auth } from "@/auth";

/// 掛單的申報事項（目前只有「使用期限」）。
///
/// 交易拍賣及移轉管理辦法第 12 條要求定價交易上架時申報使用期限與用途。
/// Listing 合約沒有這個欄位，Phase 0 先存鏈下並隨掛單公告；
/// 正式版應與掛單一起上鏈，否則「申報」只存在於平台的資料庫裡，說服力不同。
export type ListingMeta = WithId & { batchId: number; seller: string; usageDeadline: string; amountKg: number };

export async function GET(req: Request) {
  try {
    const batchId = new URL(req.url).searchParams.get("batchId");
    const rows = all<ListingMeta>("listing-meta");
    return ok({ meta: batchId ? rows.filter((r) => r.batchId === Number(batchId)) : rows });
  } catch (e) { return handleError(e); }
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) return fail("UNAUTHENTICATED");
    const b = (await req.json()) as Partial<ListingMeta>;
    if (!isAddress(b.seller) || typeof b.batchId !== "number") {
      return fail("MISSING_PARAM", { message: "batchId 與 seller 必填", details: { params: ["batchId", "seller"] } });
    }
    return ok(insert<ListingMeta>("listing-meta", {
      batchId: b.batchId, seller: b.seller, usageDeadline: b.usageDeadline ?? "", amountKg: b.amountKg ?? 0,
    }));
  } catch (e) { return handleError(e); }
}
