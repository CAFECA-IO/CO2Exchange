import "server-only";
import { auth } from "@/auth";
import { ApiError } from "./api";

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
  if (!m) throw new ApiError("UNAUTHENTICATED");
  if (role === "admin" && !m.isAdmin) throw new ApiError("ADMIN_REQUIRED");
  if (role === "verifier" && !m.isVerifier) throw new ApiError("VERIFIER_REQUIRED");
  return m;
}

/// 這個檔案現在**只回答「你是誰、你能不能」**。
///
/// 錯誤怎麼分類、回應長什麼樣，全部搬到 lib/server/api.ts 了。
/// 以前兩件事混在這裡（`HttpError` 與 `handle()` 就住在角色判定旁邊），
/// 結果是每加一個端點都要先讀一遍這個檔案才知道錯誤會變成什麼形狀。
/// 現在分開：**權限在這裡，形狀在 api.ts**。
