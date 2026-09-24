import { portfolio } from "@/lib/server/portfolio";
import { isAddress } from "@/lib/server/chain";
import { fail, handleError, ok } from "@/lib/server/api";

export async function GET(req: Request) {
  try {
    const account = new URL(req.url).searchParams.get("account");
    if (!isAddress(account)) return fail("INVALID_ADDRESS", { details: { param: "account" } });
    return ok(await portfolio(account));
  } catch (e) { return handleError(e); }
}
