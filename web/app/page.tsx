"use client";
import { useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { useAccount } from "@/components/AccountProvider";
import { Button, Card, Field, Notice, inputCls } from "@/components/ui";
import Link from "next/link";

export default function Home() {
  const { data: session, status } = useSession();
  const { config, credential, busy, createAccount, useExistingPasskey, forget } = useAccount();
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const providers = config?.providers ?? [];

  async function run(fn: () => Promise<void>) {
    setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="grid gap-6 md:grid-cols-[1.2fr_1fr]">
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">減量額度登錄、交易與註銷平台</h1>
        <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          企業完成 ISO 14064-2 減量與第三方查驗後，由查驗機構在鏈上簽章核發額度；個人、機構與企業可購買並註銷，取得可附於申報文件的憑證。
        </p>
        <ol className="space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
          <li><b>1. 登入</b> — Apple / Google 帳號只用來建立 session。</li>
          <li><b>2. 建立帳戶</b> — 用裝置的 passkey（FaceID / TouchID）當鏈上帳戶的唯一金鑰，沒有助記詞、沒有第三方託管。</li>
          <li><b>3. 身分驗證</b> — 以工商憑證 / 自然人憑證綁定帳戶地址（Phase 0 為模擬）。</li>
          <li><b>4. 購買並註銷</b> — 從企業掛單或流動性池買入，註銷後取得憑證。</li>
        </ol>
        {config && (
          <p className="text-xs text-zinc-500">鏈 ID {config.deployment.chainId} · RPC {config.rpcUrl}</p>
        )}
      </div>

      <div className="space-y-4">
        {status === "loading" ? null : !session?.user ? (
          <Card title="登入">
            <div className="space-y-3">
              {providers.includes("google") && <Button onClick={() => signIn("google", { callbackUrl: "/" })} variant="secondary">使用 Google 登入</Button>}
              {providers.includes("apple") && <Button onClick={() => signIn("apple", { callbackUrl: "/" })} variant="secondary">使用 Apple 登入</Button>}
              {providers.includes("dev") && (
                <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await signIn("dev", { email, redirect: false }); if (r?.error) throw new Error("登入失敗"); }); }}>
                  <Field label="開發用登入（任意 email）"><input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required /></Field>
                  <Button type="submit">登入</Button>
                </form>
              )}
              {!providers.includes("google") && !providers.includes("apple") && (
                <p className="text-xs text-zinc-500">在 .env.local 設定 AUTH_GOOGLE_ID / AUTH_APPLE_ID 後會出現 Google / Apple 登入。</p>
              )}
            </div>
          </Card>
        ) : !credential ? (
          <Card title="建立鏈上帳戶">
            <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">已登入：{session.user.email}。接下來用 passkey 建立帳戶；地址由公鑰決定，換裝置後同一把 passkey 仍對到同一地址。</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => run(createAccount)} disabled={!!busy}>{busy ?? "建立新帳戶（passkey）"}</Button>
              <Button variant="secondary" onClick={() => run(useExistingPasskey)} disabled={!!busy}>我已有 passkey</Button>
            </div>
          </Card>
        ) : (
          <Card title="帳戶已就緒">
            <dl className="space-y-1 text-sm">
              <div><dt className="text-zinc-500">登入</dt><dd>{session.user.email}</dd></div>
              <div><dt className="text-zinc-500">鏈上地址</dt><dd className="font-mono break-all">{credential.address}</dd></div>
            </dl>
            <div className="mt-4 flex gap-2">
              <Link href="/kyc"><Button>下一步：身分驗證</Button></Link>
              <Button variant="secondary" onClick={forget}>移除此裝置的帳戶紀錄</Button>
            </div>
          </Card>
        )}
        {err && <Notice kind="error">{err}</Notice>}
      </div>
    </div>
  );
}
