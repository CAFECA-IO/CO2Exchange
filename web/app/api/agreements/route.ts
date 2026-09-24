import { agreement, agreementMetas, acceptancesOf, missingAgreements, recordAcceptance } from "@/lib/server/agreements";
import { fail, handleError, ok } from "@/lib/server/api";
import { isAddress } from "@/lib/server/chain";
import { auth } from "@/auth";

/// GET                  → 所有契約的中繼資料（不含條文）
/// GET ?id=             → 單一契約（含條文）
/// GET ?account=&need=  → 這個帳戶還缺簽哪幾份（need 為逗號分隔的 id）
export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const id = u.searchParams.get("id");
    if (id) {
      const a = agreement(id);
      return a ? ok(a) : fail("AGREEMENT_NOT_FOUND", { details: { id } });
    }
    const account = u.searchParams.get("account");
    if (account) {
      if (!isAddress(account)) return fail("INVALID_ADDRESS", { details: { param: "account" } });
      const need = (u.searchParams.get("need") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      return ok({
        accepted: acceptancesOf(account).map((r) => ({ docId: r.docId, version: r.version, hash: r.hash, at: r.createdAt })),
        missing: need.length ? missingAgreements(account, need) : [],
      });
    }
    return ok({ agreements: agreementMetas() });
  } catch (e) { return handleError(e); }
}

/// POST { account, ids[], reviewStartedAt?, context? } → 記錄同意
/// 簽的是「當下這一版的雜湊」，不是「這份契約」：條文改版後舊簽名不再有效，會再問一次。
export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) return fail("UNAUTHENTICATED");
    const { account, ids, reviewStartedAt, context } = (await req.json()) as
      { account?: string; ids?: string[]; reviewStartedAt?: string; context?: string };
    if (!isAddress(account) || !Array.isArray(ids) || ids.length === 0) {
      return fail("MISSING_PARAM", { message: "account 與 ids 必填", details: { params: ["account", "ids"] } });
    }
    const out = [];
    for (const id of ids) {
      const a = agreement(id);
      if (!a) return fail("AGREEMENT_NOT_FOUND", { details: { id } });
      out.push(recordAcceptance({
        account, email: session.user.email ?? "", docId: a.id, version: a.version, hash: a.hash,
        reviewStartedAt, context,
      }));
    }
    return ok({ accepted: out.length });
  } catch (e) { return handleError(e); }
}
