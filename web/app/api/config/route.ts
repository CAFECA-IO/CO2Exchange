import { deployment, RPC_URL } from "@/lib/server/chain";
import { providerIds } from "@/auth";

export async function GET() {
  const d = deployment();
  return Response.json({ deployment: d, rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? RPC_URL, providers: providerIds });
}
