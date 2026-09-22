"use client";
import { useState } from "react";
import { signIn, useSession } from "next-auth/react";
import Link from "next/link";
import { useAccount } from "@/components/AccountProvider";
import { Button, Field, Notice, inputCls } from "@/components/ui";
import { NO_LOGIN_BODY, NO_LOGIN_TITLE, hasLogin } from "@/lib/login";
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
  const { busy, createAccount, useExistingPasskey, requestThisDevice, config, wallet, thisDeviceActive } = useAccount();
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

  // 錢包狀態由伺服器回答（地址由登入帳號決定，這台裝置知不知道無關）。
  // null = 還沒問到，這時候不要斷言任何一邊。
  const hasWallet = !!wallet?.exists;
  const ready = hasWallet && thisDeviceActive;
  const [sent, setSent] = useState(false);

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
            {/*
              一個供應商都沒有的時候，這個分支原本什麼都不畫——於是導覽列的「登入」
              捲到這裡，畫面上空一塊，看起來就是按鈕壞了。要等 config 回來再說，
              免得每次載入都先閃一句「沒有開放登入」。
            */}
            {config && !hasLogin(providers) && (
              <div data-testid="no-login" className="max-w-xl">
                <Notice>
                  <b>{NO_LOGIN_TITLE}</b>
                  <span className="mt-1 block text-ink-200">{NO_LOGIN_BODY}</span>
                </Notice>
              </div>
            )}
          </>
        ) : !ready ? (
          // 錢包已經在鏈上、只是這台裝置沒鑰匙的話，主要動作是「把鑰匙裝回來」，
          // 不是「再建一個錢包」——後者在新模型下根本不存在：一個登入帳號一個錢包。
          hasWallet ? (
            <>
              <Button onClick={() => run(useExistingPasskey)} disabled={!!busy}>{busy ?? "用 passkey 綁定這台裝置"}</Button>
              <Button
                variant="secondary"
                disabled={!!busy || sent}
                onClick={() => run(async () => { const r = await requestThisDevice(""); setSent(r.pending); })}
              >
                申請加入這台裝置
              </Button>
              {/* 新裝置不能自己把自己加進來。這句話要在按下去之前說，不是在之後。 */}
              <span className="w-full text-xs text-ink-300">
                {sent
                  ? "已送出申請，請用一台已經在錢包裡的裝置核准。"
                  : "新裝置要由一台現有裝置核准才能簽字——否則登入被盜就等於錢包被盜。"}
              </span>
            </>
          ) : (
            <Button onClick={() => run(createAccount)} disabled={!!busy}>{busy ?? "建立鏈上錢包（passkey）"}</Button>
          )
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

      {session?.user && !ready && (
        // 「尚未建立鏈上帳戶」對換了裝置的人來說是錯的：錢包好端端在鏈上，
        // 只是這個瀏覽器沒有那把 passkey。知道了就要照實講。
        <p className="text-xs text-ink-300">
          已登入 {session.user.email}。
          {hasWallet && wallet ? (
            <>
              你的錢包是 <span className="font-mono">{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</span>
              ，資產都在，只是<b>這台裝置沒有鑰匙</b>。地址由登入帳號決定，不會因為換裝置而改變。
            </>
          ) : (
            <>錢包地址由登入帳號決定：同一個帳號在任何裝置登入，都是同一個地址。</>
          )}
        </p>
      )}
      {ready && wallet && (
        // data-testid 而不是靠文案：帳戶好了沒有是一個**狀態**，
        // e2e 要等的是那個狀態，不是某一句話。之前這裡等的是「帳戶已就緒」四個字，
        // 於是改一次文案就有三個測試掛掉——掛的不是功能，是字串。
        <p data-testid="account-ready" className="text-xs text-ink-300">
          帳戶已就緒 · <span className="font-mono">{wallet.address}</span>
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
    </div>
  );
}
