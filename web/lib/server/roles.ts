import "server-only";
import { auth } from "@/auth";

/// Phase 0：管理員與查驗機構以 email 允許清單判定（ADMIN_EMAILS / VERIFIER_EMAILS，逗號分隔）。
/// 正式環境：管理員走機關 SSO；查驗機構用自己的系統簽發 attestation，不經本站。
function list(env: string | undefined, fallback: string) {
  return (env ?? fallback).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
export const ADMIN_EMAILS = list(process.env.ADMIN_EMAILS, "admin@example.com");
export const VERIFIER_EMAILS = list(process.env.VERIFIER_EMAILS, "verifier@example.com");

export type Me = { email: string; id: string; isAdmin: boolean; isVerifier: boolean };

export async function me(): Promise<Me | null> {
  const s = await auth();
  const email = s?.user?.email?.toLowerCase();
  if (!s?.user || !email) return null;
  return { email, id: s.user.id ?? email, isAdmin: ADMIN_EMAILS.includes(email), isVerifier: VERIFIER_EMAILS.includes(email) };
}

export async function requireRole(role: "admin" | "verifier" | "user"): Promise<Me> {
  const m = await me();
  if (!m) throw new HttpError(401, "unauthenticated");
  if (role === "admin" && !m.isAdmin) throw new HttpError(403, "需要管理員權限");
  if (role === "verifier" && !m.isVerifier) throw new HttpError(403, "需要查驗機構權限");
  return m;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function handle(e: unknown): Response {
  if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
  const msg = e instanceof Error ? e.message : String(e);
  return Response.json({ error: msg }, { status: 400 });
}
