import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Apple from "next-auth/providers/apple";
import Credentials from "next-auth/providers/credentials";

/// 登入只建立 session，不是身分根。身分效力來自 KYC 頁的政府憑證 attestation；
/// 錢包金鑰是裝置上的 passkey。Apple / Google 需在 .env.local 設定 client id/secret 才會出現。
const providers: NextAuthConfig["providers"] = [];
export const providerIds: string[] = [];
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) { providers.push(Google); providerIds.push("google"); }
if (process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET) { providers.push(Apple); providerIds.push("apple"); }
if (process.env.NODE_ENV !== "production" || process.env.AUTH_DEV_LOGIN === "1") {
  providerIds.push("dev");
  providers.push(
    Credentials({
      id: "dev",
      name: "開發用登入",
      credentials: { email: { label: "Email", type: "email" } },
      async authorize(c) {
        const email = String(c?.email ?? "").trim().toLowerCase();
        if (!email) return null;
        return { id: `dev:${email}`, email, name: email.split("@")[0] };
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt" },
  callbacks: {
    jwt({ token, user, account }) {
      if (user) token.sub = user.id ?? token.sub;
      if (account) token.provider = account.provider;
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        (session.user as { provider?: string }).provider = token.provider as string | undefined;
      }
      return session;
    },
  },
});
