import { isAddress } from "@/lib/server/chain";
import { fail, handleError, ok } from "@/lib/server/api";
import { ledgerCertificates } from "@/lib/server/ledger/registry";

/// GET ?account= → 這個帳戶的註銷憑證（帳本裡的 retire 事件）
export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account");
  if (!isAddress(account)) return fail("INVALID_ADDRESS", { details: { param: "account" } });
  try {
    return ok({ certificates: ledgerCertificates(account) });
  } catch (e) { return handleError(e); }
}
