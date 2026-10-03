import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { cookies } from "next/headers";
import { getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { devKeyOf } from "@/lib/server/dev-key";
import { verifySignIn, type SignInResponse } from "@/lib/server/cafeca/verify";
import { adoptCafecaIdentity, syncCafecaIdentity } from "@/lib/server/kyc-cafeca";
import { NONCE_COOKIE } from "@/app/api/auth/cafeca/nonce/route";

/// 登入 = 證明你控制一個 CAFECA 身分合約。
///
/// 這是這一版最大的改動，值得把前後差別寫清楚：
///
/// **以前**：Google / Apple 登入 → email → `keccak256("co2x:account:v1:" + email)`
/// → CREATE2 推出一個我們自己的 `PasskeyAccount` 地址。登入供應商認的是信箱，
/// 錢包認的是裝置上的 passkey，兩者由我們在中間黏起來——那條黏線就是 `accountRef`，
/// 而它的弱點寫在原本的註解裡：企業網域把信箱重新配發給另一個人，那個人會拿到同一個地址。
///
/// **現在**：使用者的 CAFECA 身分合約地址**就是**他在本站的 ID，也是帳本上的地址。
/// 沒有推導、沒有對照表、沒有中間那條黏線。換裝置、換 passkey、以實體卡恢復之後
/// 地址都不變，因為那是合約地址，不是金鑰的函數。
///
/// 這樣做解掉了 `accountRef` 的信箱重配發風險，以及「登入身分」與「錢包身分」是兩套東西。
///
/// 登入只證明「你是誰」。委託、撤單、註銷與提領請求另外走 CAFECA 的**簽章通道**
///（`sign_typed_data`，登入時徵詢使用者是否開啟）：每一筆都是使用者在錢包裡逐欄核對後簽的
/// EIP-712 訊息，帳本收單時驗簽（lib/ledger/signatures.ts）。session 只決定能不能開那個頁面，
/// 不能替任何人下單。
const providers: NextAuthConfig["providers"] = [];
export const providerIds: string[] = ["cafeca"];

providers.push(
  Credentials({
    id: "cafeca",
    name: "以 CAFECA 登入",
    credentials: { response: { label: "SignIn response", type: "text" } },
    async authorize(c) {
      let res: SignInResponse;
      try { res = JSON.parse(String(c?.response ?? "")) as SignInResponse; } catch { return null; }

      // nonce 必須是**這個瀏覽器**剛才拿到的那一個。verifySignIn 會另外驗它是不是
      // 本站發的、有沒有用過；這裡驗的是「是不是發給你的」。少了這一道，
      // 一組在別處取得的有效回應可以從任何瀏覽器送進來。
      const bound = (await cookies()).get(NONCE_COOKIE)?.value;
      if (!bound || bound !== res?.message?.nonce) {
        // 最常見的是按了兩次登入（第二次換發了 nonce，第一個視窗簽的是舊的）或 cookie 被擋
        console.warn("[cafeca] 登入驗證失敗：", bound ? "回應的 nonce 不是這個瀏覽器最近拿到的那一個" : "瀏覽器沒有帶 nonce cookie");
        return null;
      }

      try {
        const u = await verifySignIn(res);
        if (u.credentialError) console.warn("[cafeca] KYC Credential 沒有通過驗證：", u.credentialError);
        // CAFECA 實名 → 帳本身分。失敗不擋登入（身分頁會說明原因），只有使用者同意提供實名相關資料時才做
        if (u.kyc && (u.credential || u.credentialError)) {
          const a = await adoptCafecaIdentity(u.account, u.kyc, u.credential, u.credentialError);
          if (!a.adopted) console.warn("[cafeca] 沒有採用實名：", a.reason);
        } else if (u.kyc) {
          // 沒有帶實名資料的登入：只重查狀態（CAFECA 暫停、撤銷時帳本身分跟著失效）
          await syncCafecaIdentity(u.account).catch((e) => console.warn("[cafeca] 實名同步失敗：", (e as Error).message));
        }
        return {
          id: getAddress(u.account),
          name: u.handle ?? `${u.account.slice(0, 6)}…${u.account.slice(-4)}`,
          email: null,
          kycLevel: u.kycLevel,
          handleVerified: u.handleVerified,
          recoveryPending: u.recoveryPending,
          onChainVerifiable: u.onChainVerifiable,
        } as never;
      } catch (e) {
        // 失敗的原因留在伺服器日誌；回給瀏覽器的只有「登入失敗」。
        console.warn("[cafeca] 登入驗證失敗：", (e as Error).message);
        return null;
      }
    },
  }),
);

/// 開發與自動化測試用的假登入。**永遠不會在正式環境出現**
/// （`AUTH_DEV_LOGIN=1` 也只在非 production 有效）。
///
/// 它直接給一個地址，而不是像以前那樣給信箱再去推導——因為新模型裡
/// 地址就是身分，多一層推導只會讓測試環境與正式環境的形狀不一樣，
/// 而那種不一樣正是「本機都好好的」這類 bug 的來源。
if (process.env.NODE_ENV !== "production") {
  providerIds.push("dev");
  providers.push(
    Credentials({
      id: "dev",
      name: "開發用登入",
      credentials: { address: { label: "地址或代號", type: "text" } },
      async authorize(c) {
        const raw = String(c?.address ?? "").trim();
        if (!raw) return null;
        // 給地址就用地址；給代號就從代號推一個穩定的假地址，
        // 同一個代號每次都是同一個帳戶。
        const address = isAddress(raw)
          ? getAddress(raw)
          : privateKeyToAccount(devKeyOf(raw)).address;
        return { id: address, name: isAddress(raw) ? `${address.slice(0, 6)}…${address.slice(-4)}` : raw, email: null, kycLevel: 2 } as never;
      },
    }),
  );
}

type Extra = { kycLevel?: number; handleVerified?: boolean; recoveryPending?: boolean; onChainVerifiable?: boolean };

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt" },
  callbacks: {
    jwt({ token, user, account }) {
      if (user) {
        token.sub = user.id ?? token.sub;
        const u = user as Extra;
        token.kycLevel = u.kycLevel ?? 0;
        token.handleVerified = u.handleVerified ?? false;
        token.recoveryPending = u.recoveryPending ?? false;
        token.onChainVerifiable = u.onChainVerifiable ?? true;
      }
      if (account) token.provider = account.provider;
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        const s = session.user as typeof session.user & Extra & { provider?: string };
        s.id = token.sub ?? "";
        s.provider = token.provider as string | undefined;
        s.kycLevel = (token.kycLevel as number | undefined) ?? 0;
        s.handleVerified = (token.handleVerified as boolean | undefined) ?? false;
        s.recoveryPending = (token.recoveryPending as boolean | undefined) ?? false;
        s.onChainVerifiable = (token.onChainVerifiable as boolean | undefined) ?? true;
      }
      return session;
    },
  },
});
