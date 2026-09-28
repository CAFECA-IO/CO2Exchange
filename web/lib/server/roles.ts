import "server-only";
import { getAddress, isAddress, type Address } from "viem";
import { auth } from "@/auth";
import { ApiError } from "./api";

/// 你是誰、你能不能。
///
/// 「你是誰」現在只有一個答案：**一個 CAFECA 身分合約地址**。
/// 以前是信箱，而信箱有兩個問題——它由登入供應商決定（企業網域可以把同一個信箱
/// 重新配發給另一個人），而且它跟鏈上的地址是兩套東西，中間要一張對照表。
/// 地址沒有這兩個問題：它是合約地址，換裝置、換 passkey、恢復之後都不變。
///
/// Phase 0：管理員與查驗機構以**地址**允許清單判定（ADMIN_ADDRESSES / VERIFIER_ADDRESSES，
/// 逗號分隔）。正式環境：管理員走機關 SSO；查驗機構用自己的系統簽發 attestation，不經本站。
function list(env: string | undefined): string[] {
  return (env ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s): s is string => isAddress(s));
}
/// 開發用登入從代號推出來的那兩個地址（私鑰 `keccak256("co2x:dev:admin@example.com")` 的地址，見 lib/server/dev-key.ts）。
/// 只在非 production 當預設值，讓本機展示與 e2e 零設定就進得去 /admin 與 /verifier。
/// production 一律以環境變數為準——**沒設就是沒有任何管理員**，這是對的：
/// 一個寫死在原始碼裡的管理員地址，在公開鏈上就是一把公開的鑰匙。
const DEV_ADMIN = "0x026f5d66f503416c3ce22be19190e0d2f9b4dd3c";
const DEV_VERIFIER = "0x5d84afce29211b06f9c1b4bf97104c8df45745a3";
const devFallback = (v: string[], dev: string) =>
  v.length === 0 && process.env.NODE_ENV !== "production" ? [dev] : v;

export const ADMIN_ADDRESSES = devFallback(list(process.env.ADMIN_ADDRESSES), DEV_ADMIN);
export const VERIFIER_ADDRESSES = devFallback(list(process.env.VERIFIER_ADDRESSES), DEV_VERIFIER);

export type Me = {
  /// CAFECA 身分合約地址。**這是使用者在本站的唯一 ID，也是帳本上的主鍵。**
  address: Address;
  /// 與 address 相同，保留這個名字是因為既有紀錄（KYC 申請、核發申請）以 id 記人。
  id: string;
  /// CAFECA 代稱，只能顯示，不能當識別依據——代稱可以更換，也可能被別人拿去用。
  handle: string | null;
  /// 0 未實名、2 已通過證件＋臉部驗證。AI 子錢包不會有實名等級。
  kycLevel: number;
  /// 身分正在恢復中：有人正在主張自己是這個帳戶的主人。敏感操作要停。
  recoveryPending: boolean;
  isAdmin: boolean;
  isVerifier: boolean;
};

export async function me(): Promise<Me | null> {
  const s = await auth();
  const raw = s?.user?.id;
  if (!raw || !isAddress(raw)) return null;
  const address = getAddress(raw);
  const key = address.toLowerCase();
  const u = s!.user as { name?: string | null; kycLevel?: number; handleVerified?: boolean; recoveryPending?: boolean };
  return {
    address,
    id: address,
    handle: u.handleVerified ? (u.name ?? null) : null,
    kycLevel: u.kycLevel ?? 0,
    recoveryPending: u.recoveryPending ?? false,
    isAdmin: ADMIN_ADDRESSES.includes(key),
    isVerifier: VERIFIER_ADDRESSES.includes(key),
  };
}

export async function requireRole(role: "admin" | "verifier" | "user"): Promise<Me> {
  const m = await me();
  if (!m) throw new ApiError("UNAUTHENTICATED");
  if (role === "admin" && !m.isAdmin) throw new ApiError("ADMIN_REQUIRED");
  if (role === "verifier" && !m.isVerifier) throw new ApiError("VERIFIER_REQUIRED");
  return m;
}

/// 恢復中的身分不能做會移動資產或改變身分狀態的事。
///
/// 理由：恢復的意思是「有人拿著另一組憑據主張這個帳戶是他的」。在那個主張被確定
/// 之前，帳戶的控制權處於爭議狀態——此時讓任何一方把資產搬走，等於讓爭議的結果
/// 由手速決定。讀取不受影響，使用者仍然看得到自己的餘額。
export function refuseIfRecovering(m: Me): void {
  if (m.recoveryPending) throw new ApiError("IDENTITY_RECOVERING");
}

/// 這個檔案現在**只回答「你是誰、你能不能」**。
///
/// 錯誤怎麼分類、回應長什麼樣，全部在 lib/server/api.ts。
