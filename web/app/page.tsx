"use client";
import { useState } from "react";
import { signIn, useSession } from "next-auth/react";
import Link from "next/link";
import { useAccount } from "@/components/AccountProvider";
import { Button, Field, Notice, inputCls } from "@/components/ui";
import GlobeHero from "@/components/GlobeHero";
import { LogoMark } from "@/components/Logo";

/// 首頁回答一個問題：**這個市場現在長什麼樣子**。
///
/// 制度的說明——什麼是自願減量專案、巴黎協定第六條、ISO 14064、額度能用在哪——
/// 全部搬到 /about。那些是進場前要讀一次的東西，不是每天回來要看的東西，
/// 把它們放在首頁，等於讓每天回來看行情的人每次都滑過七千字。

/// 下一步的按鈕會隨著帳戶狀態換：還沒登入就先登入，登入了沒帳戶就建帳戶，
/// 都有了就直接去交易。一個頁面上只出現一個「下一步」，不要讓人自己挑。
function NextStep() {
  const { data: session, status } = useSession();
  const { credential, busy, createAccount, useExistingPasskey, config } = useAccount();
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const providers = config?.providers ?? [];
  // dev 是唯一的登入方式時（本機開發、Phase 0 展示），表單直接攤開。
  // 把唯一的入口收在一個「開發用登入」按鈕後面，只是讓每個人都多點一下。
  const devOnly = providers.includes("dev") && !providers.includes("google") && !providers.includes("apple");
  const [showDev, setShowDev] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  // 載入中的佔位也掛上 id：導覽列的 /#login 可能在 session 還沒回來時就跳過去了。
  if (status === "loading") return <div id="login" className="h-10 scroll-mt-24" />;

  return (
    <div id="login" className="scroll-mt-24 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {!session?.user ? (
          <>
            {providers.includes("google") && (
              <Button onClick={() => signIn("google", { callbackUrl: "/" })}>使用 Google 登入</Button>
            )}
            {providers.includes("apple") && (
              <Button variant="secondary" onClick={() => signIn("apple", { callbackUrl: "/" })}>使用 Apple 登入</Button>
            )}
            {providers.includes("dev") && !devOnly && (
              <button onClick={() => setShowDev((v) => !v)} className="text-xs text-ink-300 underline hover:text-ink-50">
                開發用登入
              </button>
            )}
          </>
        ) : !credential ? (
          <>
            <Button onClick={() => run(createAccount)} disabled={!!busy}>{busy ?? "建立鏈上帳戶（passkey）"}</Button>
            <Button variant="secondary" onClick={() => run(useExistingPasskey)} disabled={!!busy}>我已有 passkey</Button>
          </>
        ) : (
          <>
            <Link href="/trade"><Button>進入交易</Button></Link>
            <Link href="/kyc"><Button variant="secondary">身分驗證</Button></Link>
          </>
        )}
        <Link href="/about" className="text-sm text-tide underline underline-offset-4 hover:text-ink-50">
          先看看碳權是什麼
        </Link>
      </div>

      {(devOnly || showDev) && providers.includes("dev") && (
        <form
          className="flex max-w-sm items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await signIn("dev", { email, redirect: false });
              if (r?.error) throw new Error("登入失敗");
            });
          }}
        >
          <Field label="開發用登入（任意 email）">
            <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
          </Field>
          <Button type="submit">登入</Button>
        </form>
      )}

      {session?.user && !credential && (
        <p className="text-xs text-ink-300">
          已登入 {session.user.email}。帳戶地址由 passkey 的公鑰決定，換裝置後同一把 passkey 仍對到同一個地址。
        </p>
      )}
      {credential && (
        // data-testid 而不是靠文案：帳戶好了沒有是一個**狀態**，
        // e2e 要等的是那個狀態，不是某一句話。之前這裡等的是「帳戶已就緒」四個字，
        // 於是改一次文案就有三個測試掛掉——掛的不是功能，是字串。
        <p data-testid="account-ready" className="text-xs text-ink-300">
          帳戶已就緒 · <span className="font-mono">{credential.address}</span>
        </p>
      )}
      {err && <Notice kind="error">{err}</Notice>}
    </div>
  );
}

export default function Home() {
  return (
    <div className="space-y-12">
      {/* ── 標題與下一步 ──────────────────────────────────────────── */}
      <header className="space-y-4">
        <div className="flex items-center gap-3 text-ink-50">
          <LogoMark className="h-9 w-auto shrink-0" />
          <h1 className="font-display text-3xl font-bold tracking-tight">
            TideBit<span className="text-tide">-DeFi</span> 碳權交易所
          </h1>
        </div>
        <p className="max-w-3xl text-sm leading-7 text-ink-200">
          亞太六個轄區核發的減量額度，同一本掛單簿。每一批都標明<b>核發國</b>——
          它的法律效力、可用途徑與註銷程序依核發國的法規辦理，不因為在本站交易而改變。
          碳權託管於各國政府的官方登錄簿帳戶、入金託管於信託專戶，每月 5 日
          <Link className="text-tide underline" href="/custody">公開對帳</Link>。
        </p>
        <NextStep />
      </header>

      {/* ── 地球：世界各國的核發量與交易量 ───────────────────────── */}
      <GlobeHero />

      <p className="border-t border-ink-500 pt-6 text-xs leading-6 text-ink-300">
        本站目前為 Phase 0 展示版本：身分驗證、查驗機構簽章與結算幣皆為模擬，額度不具法律效力，不得作為任何申報依據。
        制度說明、各國機制與額度的可用途徑請見
        <Link className="text-tide underline" href="/about">認識碳權</Link>。
      </p>
    </div>
  );
}
