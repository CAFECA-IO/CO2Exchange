"use client";
import { useState } from "react";
import { signIn, useSession } from "next-auth/react";
import Link from "next/link";
import { useAccount } from "@/components/AccountProvider";
import { Button, Field, Notice, inputCls } from "@/components/ui";
import { NO_LOGIN_BODY, NO_LOGIN_TITLE, hasLogin } from "@/lib/login";
import { signInWithCafeca } from "@/lib/client/cafeca";
import GlobeHero from "@/components/GlobeHero";
import { LogoMark } from "@/components/Logo";

/// 首頁回答一個問題：**這個市場現在長什麼樣子**。
///
/// 制度的說明——什麼是自願減量專案、巴黎協定第六條、ISO 14064、額度能用在哪——
/// 全部搬到 /about。那些是進場前要讀一次的東西，不是每天回來要看的東西，
/// 把它們放在首頁，等於讓每天回來看行情的人每次都滑過七千字。

/// 下一步的按鈕會隨著帳戶狀態換：還沒登入就先登入，登入了但沒開簽章通道就開通道，
/// 都有了就直接去交易。一個頁面上只出現一個「下一步」，不要讓人自己挑。
///
/// 改用 CAFECA 之後少掉了整個「建立錢包」與「把這台裝置的 passkey 裝回來」的分支：
/// 帳戶就是使用者的身分合約，他一登入就已經有了。
function NextStep() {
  const { data: session, status } = useSession();
  const { busy, config, wallet, channelOpen, recheckChannel } = useAccount();
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const providers = config?.providers ?? [];
  // dev 是唯一的登入方式時（本機開發、Phase 0 展示），表單直接攤開。
  // 把唯一的入口收在一個「開發用登入」按鈕後面，只是讓每個人都多點一下。
  const devOnly = providers.includes("dev") && !providers.includes("cafeca");
  const [showDev, setShowDev] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const cafecaLogin = () =>
    run(async () => {
      const response = await signInWithCafeca();
      const r = await signIn("cafeca", { response, redirect: false });
      if (r?.error) throw new Error("登入驗證沒有通過");
    });

  // null = 還沒問到，這時候不要斷言任何一邊。
  const ready = !!wallet && channelOpen === true;

  if (status === "loading") return <div id="login" className="h-10 scroll-mt-24" />;

  return (
    <div id="login" className="scroll-mt-24 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {!session?.user ? (
          <>
            {providers.includes("cafeca") && (
              // 這個 onClick 直接呼叫 signInWithCafeca，中間**不 await 任何東西**：
              // 彈出視窗必須開在使用者手勢的作用範圍內，先 await 一個 fetch
              // 就會被瀏覽器擋下。nonce 是以函式的形式交給 SDK 的，見 lib/client/cafeca.ts。
              <Button disabled={!!busy} onClick={cafecaLogin}>以 CAFECA 登入</Button>
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
          // 登入了但沒開簽章通道：看得到，動不了。這一步要講清楚是缺什麼，
          // 否則使用者只會看到一堆按下去就失敗的按鈕。
          <>
            <Button onClick={cafecaLogin} disabled={!!busy}>{busy ?? "開啟簽章通道"}</Button>
            <Button variant="secondary" onClick={recheckChannel}>我已經開了，重新檢查</Button>
            <span className="w-full text-xs text-ink-300">
              沒有通道就下不了單、也送不出交易。<b>通道不是授權</b>：每一筆都會在 CAFECA
              錢包顯示實際內容，由你確認才簽，也可以隨時在 CAFECA 關掉。
            </span>
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
              const r = await signIn("dev", { address: email, redirect: false });
              if (r?.error) throw new Error("登入失敗");
            });
          }}
        >
          <Field label="開發用登入（地址或代號）">
            <input className={inputCls} type="text" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="0x… 或 alice" required />
          </Field>
          <Button type="submit">登入</Button>
        </form>
      )}

      {session?.user && !ready && (
        // 「還沒建立帳戶」在新模型下永遠是錯的：帳戶就是使用者的身分合約，
        // 他一登入就已經有了。缺的是通道，那是另一件事，要照實講。
        <p className="text-xs text-ink-300">
          已登入 {session.user.name ?? session.user.id}。
          {wallet ? (
            <>
              你的帳戶是 <span className="font-mono">{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</span>
              ，持倉都在，只是<b>還沒開啟簽章通道</b>。這個地址是你的 CAFECA 身分合約，
              換裝置、換 passkey、恢復之後都不會變。
            </>
          ) : (
            <>你的帳戶就是你的 CAFECA 身分合約地址：在任何裝置登入都是同一個。</>
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
