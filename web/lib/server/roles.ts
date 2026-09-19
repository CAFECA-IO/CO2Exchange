import "server-only";
import { auth } from "@/auth";
import { isStaleData } from "./fingerprint";

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

/// 節點連不上（RPC 沒開、port 不對、鏈掛了）與合約層錯誤要分開：
/// 前者是環境問題，回 503 並給出可操作的訊息，不要把 viem 的 stack trace 丟到畫面上。
export function isChainUnreachable(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 8; i++) {
    const m = cur instanceof Error ? cur.message : "";
    if (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed|HTTP request failed/i.test(m)) return true;
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return false;
}

/// eth_call 回 "0x" 代表那個地址上根本沒有合約 —— 幾乎都是部署檔與鏈對不上：
/// 鏈重開了沒重新部署，或部署檔指向另一條鏈。分出來講清楚，不要丟 viem 的 stack trace。
export function isDeploymentMismatch(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 8; i++) {
    const m = cur instanceof Error ? cur.message : "";
    if (/returned no data \("0x"\)|Cannot decode zero data/i.test(m)) return true;
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return false;
}

export function handle(e: unknown): Response {
  if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
  if (isChainUnreachable(e)) {
    const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8545";
    return Response.json(
      { error: `無法連線到區塊鏈節點（${rpc}）。請確認節點已啟動，且 web/.env.local 的 RPC_URL / CHAIN_ID 指向正確的鏈。`, code: "CHAIN_UNREACHABLE" },
      { status: 503 },
    );
  }
  if (isDeploymentMismatch(e)) {
    const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8545";
    return Response.json(
      {
        error:
          `部署檔與鏈對不上：合約地址上沒有程式碼（${rpc}）。` +
          `通常是鏈重開後沒有重新部署。請重跑 forge script script/DeployV4.s.sol --rpc-url anvil --broadcast，` +
          `並確認 CHAIN_ID 與 deployments/<chainId>.json 對應到同一條鏈。`,
        code: "DEPLOYMENT_MISMATCH",
      },
      { status: 503 },
    );
  }
  if (isStaleData(e)) {
    return Response.json({ error: e.message, code: "DATA_STALE" }, { status: 503 });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return Response.json({ error: msg }, { status: 400 });
}
