import { me } from "@/lib/server/roles";
export async function GET() {
  const m = await me();
  return Response.json(m ?? { email: null, isAdmin: false, isVerifier: false });
}
