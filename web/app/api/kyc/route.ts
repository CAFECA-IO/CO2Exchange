import { IS_LOCAL_CHAIN, isAddress } from "@/lib/server/chain";
import { TIER } from "@/lib/deployment";
import { all, insert, patch } from "@/lib/server/store";
import { attestAndRegister, purgeIdNumber, sealKyc, validateId, type KycRequest } from "@/lib/server/kyc";
import { me, requireRole } from "@/lib/server/roles";
import { acceptPrototype, cafecaRecordOf, lastAdoptionOf } from "@/lib/server/kyc-cafeca";
import { ApiError, fail, handleError, ok } from "@/lib/server/api";
import { ledgerIdentity } from "@/lib/server/ledger/registry";

/// GET ?account= → 帳本身分 + 最新申請狀態
export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account");
  if (!isAddress(account)) return fail("INVALID_ADDRESS", { details: { param: "account" } });
  try {
  const id = ledgerIdentity(account);
  const reqs = all<KycRequest>("kyc-requests").filter((r) => r.account.toLowerCase() === account.toLowerCase());
  const latest = reqs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  // CAFECA 實名的細節（為什麼還沒有身分、簽章者等級）只給帳戶本人看
  const viewer = await me();
  const self = !!viewer && viewer.address.toLowerCase() === account.toLowerCase();
  const rec = self ? cafecaRecordOf(account) : null;
  const last = self ? lastAdoptionOf(account) : null;
  return ok({
    tier: id.tier, expiry: Number(id.expiry), frozen: id.frozen, jurisdiction: id.jurisdiction, identityHash: id.identityHash,
    application: latest ? { id: latest.id, status: latest.status, tier: latest.tier, reason: latest.reason, createdAt: latest.createdAt, source: latest.source ?? "manual" } : null,
    cafeca: self ? {
      record: rec ? { status: rec.status, tier: rec.tier, reason: rec.reason, ...rec.cafeca } : null,
      last: last ? { adopted: last.adopted, reason: last.reason, at: last.at } : null,
      acceptPrototype: acceptPrototype(),
      /// 自然人只能用 CAFECA 實名；人工審核只留給 CAFECA 還不支援的主體（本機鏈除外：開發與自動測試）
      manualIndividual: IS_LOCAL_CHAIN,
    } : null,
  });
  } catch (e) { return handleError(e); }
}

/// POST { account, tier, idNumber, name } → 建立申請。KYC_AUTO_APPROVE=1 時直接簽發（demo / e2e）。
export async function POST(req: Request) {
  try {
    const m = await requireRole("user");
    const body = (await req.json()) as { account?: string; tier?: number; idNumber?: string; name?: string };
    const { account, tier } = body;
    if (!isAddress(account)) throw new ApiError("INVALID_ADDRESS", undefined, { param: "account" });
    if (tier !== TIER.Individual && tier !== TIER.Corporate) throw new ApiError("INVALID_PARAM", "身分等級只能是自然人或法人", { param: "tier" });
    if (tier === TIER.Individual && !IS_LOCAL_CHAIN) {
      throw new ApiError("INVALID_PARAM", "自然人請以 CAFECA 實名驗證（登入時同意提供姓名與同一人識別碼），本站不再收身分證號", { param: "tier" });
    }
    const idn = validateId(tier, String(body.idNumber ?? ""));
    const row = insert<KycRequest>("kyc-requests", {
      account, tier, submittedBy: m.address, status: "pending", source: "manual", ...sealKyc(account, idn, String(body.name ?? "").trim().slice(0, 100)),
    });
    if (process.env.KYC_AUTO_APPROVE === "1") {
      const r = await attestAndRegister(account, tier, idn);
      patch<KycRequest>("kyc-requests", row.id, { status: "approved", txHash: r.txHash, identityHash: r.identityHash, decidedBy: "auto", ...purgeIdNumber });
      return ok({ id: row.id, status: "approved", txHash: r.txHash, identityHash: r.identityHash });
    }
    return ok({ id: row.id, status: "pending" });
  } catch (e) { return handleError(e); }
}
