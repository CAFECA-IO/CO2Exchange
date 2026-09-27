import "server-only";
import { isAddress, parseAbi, type Address, type Hex } from "viem";
import { ApiError } from "../api";
import { cafecaConfig, identityClient, WALLET_ORIGIN } from "./config";
import { consumeNonce } from "./nonce";
import { signInDigest } from "./digest";

/// 「以 CAFECA 登入」的後端驗證。
///
/// 前端拿到的那包東西**一律不可信**——它經過使用者的瀏覽器，改一個欄位是幾秒鐘的事。
/// 所以這支檔案不看前端說了什麼，只看三件自己查得到的事：
///
///   1. 這則訊息的收件人是不是我們（`domain` 與本站 origin 逐字相同）。
///   2. 這個 nonce 是不是我們剛發出、而且還沒用過的。
///   3. 那個身分合約自己承不承認這個簽章（ERC-1271，一次 eth_call）。
///
/// 第一件是防仿冒的全部：使用者在假網站上簽下的訊息，`domain` 是假網站的網域，
/// 拿到這裡逐字比對就是不合。**所以這個比對必須逐字**——用 `endsWith` 或只比主機名，
/// `evil-shop.example` 與 `shop.example.attacker.com` 都會過關。
///
/// 第三件是身分的全部：使用者的地址就是他的身分合約，換裝置、換 passkey、
/// 以實體卡恢復之後都不會變。這也正是我們把它當成交易所帳本主鍵的理由。

const ERC1271_MAGIC = "0x1626ba7e";
const erc1271Abi = parseAbi(["function isValidSignature(bytes32,bytes) view returns (bytes4)"]);
const attestationAbi = parseAbi(["function levelOf(address) view returns (uint8)"]);
const recoveryAbi = parseAbi(["function isPending(address) view returns (bool)"]);

/// 線上傳過來的樣子：JSON 沒有 bigint，所以時間欄位是 number。
/// 進雜湊之前才轉成 bigint（digest.ts 的 SignInMessage），這個界線要分清楚——
/// 兩種型別長得很像，混用不會有人發現，直到 digest 對不上為止。
export type WireMessage = {
  domain: string; uri: string; nonce: string;
  issuedAt: number; expiresAt: number; statement: string; claims: string;
};

export type SignInResponse = {
  v?: number;
  type?: string;
  account?: string;
  chainId?: number;
  message?: Partial<WireMessage>;
  signature?: string;
  claims?: Record<string, unknown>;
  state?: string;
  error?: string;
};

export type CafecaUser = {
  /// 身分合約地址。**這就是使用者在本站的唯一 ID，也是他在帳本上的地址。**
  account: Address;
  chainId: number;
  /// 實名等級。0 未實名、2 已通過證件＋臉部驗證。
  /// AI 子錢包是獨立地址且不會有實名等級，所以這個值也是「本人 vs 代理」的判準。
  kycLevel: number;
  handle: string | null;
  /// 代稱是否由錢包查詢確認過。false 代表只能顯示，不能當識別依據。
  handleVerified: boolean;
  /// 身分正在恢復中。敏感操作要暫停——恢復中代表「有人正在主張自己是這個帳戶的主人」。
  recoveryPending: boolean;
  /// 簽章能不能在鏈上重驗。false = 身分與資產不同鏈，爭議只能在鏈下處理。
  onChainVerifiable: boolean;
  state?: string;
};

/// 這個帳戶合約承不承認這個簽章（ERC-1271）。
///
/// 登入與委託單驗的是同一件事，只有 digest 不同，所以只寫一次。
///
/// **讀不到就是不承認。** 合約不存在、還沒部署、RPC 連不上——三種都回 false，
/// 不是丟例外讓呼叫端自己決定。理由是這個函式的答案只有一個安全的預設值：
/// 一個「我不知道」被當成「有效」的分支，就是一個任何人都能走進來的門。
export async function accountAcceptsSignature(account: Address, digest: Hex, signature: Hex): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]*$/.test(signature)) return false;
  try {
    const { client } = await identityClient();
    const magic = await client.readContract({
      address: account, abi: erc1271Abi, functionName: "isValidSignature", args: [digest, signature],
    });
    return magic.toLowerCase() === ERC1271_MAGIC;
  } catch {
    return false;
  }
}

const fail = (why: string): never => {
  throw new ApiError("SIGNIN_REJECTED", why);
};

/// `domain` 必須與本站 origin 逐字相同（含 scheme 與 port）。
/// 從環境變數讀，不從請求標頭讀——`Host` 是呼叫端說的，拿它比對等於沒有比對。
export function siteOrigin(): string {
  const o = process.env.SITE_ORIGIN ?? process.env.NEXTAUTH_URL ?? process.env.AUTH_URL;
  if (!o) throw new ApiError("INTERNAL", "缺少 SITE_ORIGIN，無法驗證 CAFECA 登入的網域綁定");
  return new URL(o).origin;
}

export async function verifySignIn(res: SignInResponse): Promise<CafecaUser> {
  if (res?.error) fail(res.error === "access_denied" ? "使用者拒絕了登入請求" : `錢包回報錯誤：${res.error}`);
  if (res?.type !== "cafeca:auth") fail("不是 CAFECA 登入回應");

  const m = res.message;
  if (!m || typeof m !== "object") fail("登入回應沒有帶訊息內容");
  const account = res.account;
  if (typeof account !== "string" || !isAddress(account)) fail("登入回應的 account 不是合法地址");

  // ── 1. 收件人是不是我們 ────────────────────────────────────
  const origin = siteOrigin();
  if (m!.domain !== origin) fail(`這個簽章是簽給 ${m!.domain ?? "（未指定）"} 的，不是本站`);
  // uri 必須與 domain 同源，否則「使用者看到的是哪一頁」與「簽給誰」可以被拆開。
  let uriOrigin: string;
  try { uriOrigin = new URL(String(m!.uri)).origin; } catch { return fail("登入回應的 uri 不是合法網址"); }
  if (uriOrigin !== origin) fail("登入回應的 uri 與本站不同源");

  // ── 2. nonce 是不是我們發的、還沒用過 ───────────────────────
  const bad = consumeNonce(String(m!.nonce ?? ""));
  if (bad) fail(bad);

  // ── 3. 時間 ────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = Number(m!.issuedAt);
  const expiresAt = Number(m!.expiresAt);
  if (!Number.isInteger(issuedAt) || !Number.isInteger(expiresAt)) fail("登入回應的時間欄位不正確");
  if (now >= expiresAt) fail("這個登入簽章已經過期");
  // 有效時間最長 600 秒是協定寫死的。放行更長的等於接受一張長期通行證。
  if (expiresAt - issuedAt > 600) fail("登入簽章的有效時間超過協定允許的 600 秒");
  // 時鐘誤差給 120 秒；再寬就等於接受未來才生效的簽章。
  if (issuedAt > now + 120) fail("登入簽章的簽發時間在未來");

  // ── 4. 鏈 ──────────────────────────────────────────────────
  const cfg = await cafecaConfig();
  if (Number(res.chainId) !== cfg.chainId) fail(`登入回應的 chainId 是 ${res.chainId}，應該是 ${cfg.chainId}`);

  // ── 5. 合約自己承不承認這個簽章 ─────────────────────────────
  // uint256 欄位要以 bigint 進 hashTypedData——傳 number 會在 2^53 以下「看起來對」，
  // 而這兩個是 Unix 秒，永遠在那個範圍內，所以型別錯了也不會有人發現，
  // 直到某天欄位換成別的用途為止。照協定的型別給。
  const digest = signInDigest(cfg.chainId, account as Address, {
    domain: String(m!.domain),
    uri: String(m!.uri),
    nonce: String(m!.nonce),
    issuedAt: BigInt(issuedAt),
    expiresAt: BigInt(expiresAt),
    statement: String(m!.statement ?? ""),
    claims: String(m!.claims ?? ""),
  });

  const signature = res.signature;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]*$/.test(signature)) fail("登入回應沒有帶合法的簽章");

  const { client, sameChain } = await identityClient();
  if (!(await accountAcceptsSignature(account as Address, digest, signature as Hex))) {
    fail("身分合約不承認這個簽章");
  }

  // ── 6. 使用者同意提供的那些 claims ──────────────────────────
  const consented = new Set(String(m!.claims ?? "").split(",").map((s) => s.trim()).filter(Boolean));

  let kycLevel = 0;
  if (consented.has("kyc_level")) {
    try {
      kycLevel = Number(await client.readContract({
        address: cfg.contracts.attestation, abi: attestationAbi, functionName: "levelOf", args: [account as Address],
      }));
    } catch {
      // 讀不到就當 0。寧可把人擋在門外，也不要因為一次 RPC 失敗就把未實名當成已實名。
      kycLevel = 0;
    }
  }

  // 回應裡自稱的 handle 不可信（它跟簽章內容無關，改了也不會讓驗證失敗），
  // 所以要嘛向錢包查一次，要嘛只當顯示字串。
  let handle: string | null = null;
  let handleVerified = false;
  if (consented.has("handle")) {
    try {
      const r = await fetch(`${WALLET_ORIGIN}/api/profile?q=${account}`, {
        cache: "no-store", signal: AbortSignal.timeout(5_000),
      });
      if (r.ok) {
        const p = (await r.json()) as { handle?: unknown };
        if (typeof p.handle === "string") { handle = p.handle; handleVerified = true; }
      }
    } catch { /* 查不到就不給代稱，不要退回用前端說的那個 */ }
    if (!handle && typeof res.claims?.handle === "string") handle = res.claims.handle as string;
  }

  let recoveryPending = false;
  try {
    recoveryPending = await client.readContract({
      address: cfg.contracts.recovery, abi: recoveryAbi, functionName: "isPending", args: [account as Address],
    });
  } catch { /* 讀不到就當沒有。這是額外提醒，不是關卡 */ }

  return {
    account: account as Address,
    chainId: cfg.chainId,
    kycLevel,
    handle,
    handleVerified,
    recoveryPending,
    onChainVerifiable: sameChain,
    state: typeof res.state === "string" ? res.state : undefined,
  };
}
