import { portfolio } from "@/lib/server/portfolio";
import { isAddress } from "@/lib/server/chain";
import { handle } from "@/lib/server/roles";

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account");
  if (!isAddress(account)) return Response.json({ error: "account" }, { status: 400 });
  try {
    return Response.json(await portfolio(account));
  } catch (e) { return handle(e); }
}
