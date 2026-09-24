"use client";
import { useState } from "react";
import Link from "next/link";
import { useAccount } from "./AccountProvider";
import { Button, Card, Notice } from "./ui";
import { NO_LOGIN_BODY, NO_LOGIN_TITLE, hasLogin } from "@/lib/login";

/// 進入內頁前的門檻畫面。
///
/// 為什麼需要它：「登入」「錢包」「這台裝置能不能簽字」是**三**件事，而舊版的文案
/// 把它們講成一件。使用者登入後看到「請先建立鏈上帳戶」，會覺得「叫我登入，
/// 又說我已登入」；換一台手機時更糟——他明明有錢包，畫面卻要他再建一個。
///
/// 現在三件事分開說：
///   · 登入      → 你是誰。決定錢包地址（一個登入帳號一個錢包）。
///   · 錢包      → 鏈上那個地址。換幾台裝置都是同一個。
///   · 這台裝置  → 有沒有一把在錢包裡的 passkey。沒有就只能看，不能動。
export function AccountGate() {
  const {
    userId, deviceCredential, config, busy, unbound, wallet, walletError, thisDeviceActive,
    createAccount, useExistingPasskey, requestThisDevice, refreshWallet, refreshConfig,
  } = useAccount();
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  // ① 沒有 session
  if (!userId) {
    // 站台根本沒開登入的時候，「回首頁登入」是一顆送人去空畫面的按鈕。
    // 說清楚為什麼進不來，並指向不需要登入也看得到的東西。
    if (config && !hasLogin(config.providers)) {
      return (
        <Card title={NO_LOGIN_TITLE}>
          <p data-testid="no-login" className="text-sm leading-7 text-ink-200">{NO_LOGIN_BODY}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/"><Button>看市場現況</Button></Link>
            <Link href="/about"><Button variant="secondary">認識碳權</Button></Link>
          </div>
        </Card>
      );
    }
    return (
      <Card title="請先登入">
        <p className="text-sm leading-7 text-ink-200">
          登入決定你的錢包是哪一個——同一個登入帳號永遠對到同一個鏈上地址。
          登入之後還要在這台裝置放一把 passkey，才能簽字動用它。
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/"><Button>回首頁登入</Button></Link>
        </div>
      </Card>
    );
  }

  // 問不到錢包狀態。**這個分支以前不存在**，於是任何一次失敗都變成一個永遠轉不完的
  // 「讀取錢包狀態中…」——沒有原因、沒有重試、沒有出口，只能重新整理（如果使用者猜得到）。
  // 伺服器其實早就把人話訊息寫好了（節點連不上、部署檔對不上、資料過期），只是被吞掉。
  if (walletError) {
    return (
      <Card title="讀不到你的錢包狀態">
        <div className="space-y-3 text-sm leading-7 text-ink-200">
          <p>
            這不代表你的錢包出事了——它在鏈上，資產也在。是<b>這次查詢</b>沒有成功。
          </p>
          <Notice kind="error">{walletError.message}</Notice>
          <p className="text-ink-300">
            已經自動重試過兩次。按下面重試，或稍後再回來；如果一直這樣，多半是節點或部署設定的問題，
            上面那句話會指出是哪一種。
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button data-testid="wallet-retry" onClick={() => { setErr(null); refreshWallet(); refreshConfig(); }}>
            重試
          </Button>
          <Link href="/about"><Button variant="secondary">先看看碳權是什麼</Button></Link>
        </div>
      </Card>
    );
  }

  // 錢包狀態還沒問到：不要在這時候斷言任何一邊。
  if (!wallet) return <Notice>{busy ?? "讀取錢包狀態中…"}</Notice>;

  // ② 有 session，錢包還不存在 → 第一次建立
  if (!wallet.exists) {
    return (
      <Card title="建立你的鏈上錢包">
        <div className="space-y-3 text-sm leading-7 text-ink-200">
          <p>
            這個登入帳號的錢包地址已經算得出來了：
            <span className="ml-1 font-mono text-ink-50">{wallet.address.slice(0, 10)}…{wallet.address.slice(-6)}</span>。
            它由<b>登入帳號</b>決定，所以之後換幾台裝置都是同一個地址。
          </p>
          <p className="text-ink-300">
            按下去會在這台裝置建立一把 passkey（Face ID / Touch ID / 螢幕鎖），
            並用它部署錢包。金鑰只留在這台裝置的安全元件裡，平台拿不到，也複製不走。
          </p>
        </div>
        <div className="mt-4">
          <Button onClick={() => run(createAccount)} disabled={!!busy}>{busy ?? "建立錢包（passkey）"}</Button>
        </div>
        {err && <div className="mt-3"><Notice kind="error">{err}</Notice></div>}
      </Card>
    );
  }

  // ③ 錢包在鏈上，但這台裝置簽不了字
  if (!thisDeviceActive) {
    const pendingHere = deviceCredential && wallet.pendingDevices.some((d) => d.keyId === deviceCredential.keyId);
    return (
      <Card title="這台裝置還不能簽署交易">
        <div className="space-y-3 text-sm leading-7 text-ink-200">
          <p>
            你的錢包好端端在鏈上
            <span className="ml-1 font-mono text-ink-50">{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</span>
            ，資產一分沒少。缺的只是<b>這台裝置的鑰匙</b>——passkey 存在裝置的安全元件裡，
            不會跟著帳號跑。
          </p>
          {unbound && (
            <Notice kind="warn">
              這台裝置記著的那把 passkey 已經不在錢包的有效金鑰裡了。
              可能是你從別台裝置把它撤掉了，也可能是合約重新部署過。
            </Notice>
          )}
          {pendingHere || sent ? (
            <Notice>
              已經送出加入申請，等待核准。請拿一台<b>已經在錢包裡</b>的裝置，
              到「裝置與安全」按核准。<br />
              一台都不剩的話，這條路走不通——要走復原程序（重新驗證身分，等待
              {Math.round((wallet.recoveryDelay || 259200) / 3600)} 小時）。請與平台聯絡。
            </Notice>
          ) : (
            <ul className="space-y-1.5 border-l-2 border-ink-500 pl-4 text-ink-300">
              <li><b>這台裝置以前綁過</b>（清掉瀏覽器資料、換個瀏覽器）→ 選「我已有 passkey」，不需要任何人核准。</li>
              <li><b>這是一台新裝置</b> → 選「申請加入」，然後用一台現有裝置核准。新裝置不能自己把自己加進來，否則登入被盜就等於錢包被盜。</li>
            </ul>
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => run(useExistingPasskey)} disabled={!!busy}>{busy ?? "我已有 passkey"}</Button>
          <Button
            variant="secondary"
            disabled={!!busy || sent}
            onClick={() => run(async () => { const r = await requestThisDevice(""); setSent(r.pending); })}
          >
            申請加入這台裝置
          </Button>
          <Link href="/account"><Button variant="secondary">裝置與安全</Button></Link>
        </div>
        {err && <div className="mt-3"><Notice kind="error">{err}</Notice></div>}
      </Card>
    );
  }

  // ④ 都有了，但設定還沒讀回來（或鏈連不上）
  return (
    <Notice>
      {busy ?? (config ? "讀取中…" : "讀取鏈上設定中…若一直停在這裡，請確認節點已啟動。")}
    </Notice>
  );
}
