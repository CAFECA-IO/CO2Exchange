"use client";
import { useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useAccount } from "./AccountProvider";
import { Button, Card, Notice } from "./ui";
import { signInWithCafeca } from "@/lib/client/cafeca";
import { NO_LOGIN_BODY, NO_LOGIN_TITLE, hasLogin } from "@/lib/login";

/// 進入內頁前的門檻畫面。
///
/// 為什麼需要它：「登入」與「能不能簽字」是**兩**件事，而把它們講成一件會產生
/// 那種最讓人火大的畫面——已登入，但每個按鈕按下去都失敗，沒有一句話說得出為什麼。
///
///   · 登入        → 你是誰。你的 CAFECA 身分合約地址就是你在本站的帳戶。
///   · 簽章通道    → 能不能請你簽字。使用者可以登入而不開通道，
///                   那樣他看得到自己的持倉，但下不了單也送不了交易。
///
/// 改用 CAFECA 之後少掉的那一件是「這台裝置有沒有 passkey」。以前錢包是本站部署的
/// `PasskeyAccount`，金鑰綁在裝置上，於是換一台手機就要走一整套「申請加入 → 現有裝置
/// 核准」的流程。現在金鑰生命週期在 CAFECA 錢包裡，本站看不到也不需要看到。
export function AccountGate() {
  const { userId, config, busy, wallet, walletError, channelOpen, recheckChannel, refreshWallet, refreshConfig } =
    useAccount();
  const [err, setErr] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  const login = () =>
    run(async () => {
      const response = await signInWithCafeca();
      const r = await signIn("cafeca", { response, redirect: false });
      if (r?.error) throw new Error("登入驗證沒有通過");
    });

  // ① 沒有 session
  if (!userId) {
    // 站台根本沒開登入的時候，「回首頁登入」是一顆送人去空畫面的按鈕。
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
        <div className="space-y-3 text-sm leading-7 text-ink-200">
          <p>
            以 CAFECA 登入。你的身分合約地址就是你在這裡的帳戶——換裝置、換 passkey、
            以實體卡恢復之後都是同一個，因為那是合約地址，不是金鑰的函數。
          </p>
          <p className="text-ink-300">
            登入時會一併徵詢你是否開啟簽章通道。開了才能下單與送交易，
            但<b>通道不是授權</b>：每一筆都會在 CAFECA 錢包顯示實際內容，由你確認才簽。
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={login} disabled={!!busy}>{busy ?? "以 CAFECA 登入"}</Button>
          <Link href="/about"><Button variant="secondary">先看看碳權是什麼</Button></Link>
        </div>
        {err && <div className="mt-3"><Notice kind="error">{err}</Notice></div>}
      </Card>
    );
  }

  // 問不到錢包狀態。**這個分支以前不存在**，於是任何一次失敗都變成一個永遠轉不完的
  // 「讀取錢包狀態中…」——沒有原因、沒有重試、沒有出口。
  if (walletError) {
    return (
      <Card title="讀不到你的帳戶狀態">
        <div className="space-y-3 text-sm leading-7 text-ink-200">
          <p>這不代表你的帳戶出事了——它在鏈上，資產也在。是<b>這次查詢</b>沒有成功。</p>
          <Notice kind="error">{walletError.message}</Notice>
          <p className="text-ink-300">
            已經自動重試過兩次。按下面重試，或稍後再回來；如果一直這樣，多半是節點或設定的問題，
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

  // 還沒問到：不要在這時候斷言任何一邊。
  if (!wallet || channelOpen === null) return <Notice>{busy ?? "讀取帳戶狀態中…"}</Notice>;

  // ② 身分正在恢復中：有人正在主張這個帳戶是他的。此時讓任何一方把資產搬走，
  //    等於讓爭議的結果由手速決定。讀取不受影響。
  if (wallet.recoveryPending) {
    return (
      <Card title="這個身分正在恢復中">
        <div className="space-y-3 text-sm leading-7 text-ink-200">
          <p>
            CAFECA 那邊有一個進行中的恢復提案——也就是有人正在主張這個帳戶是他的。
            在它結束之前，交易與註銷會暫停。你仍然看得到自己的持倉。
          </p>
          <Notice kind="warn">
            如果這不是你發起的，請立刻到 CAFECA 錢包否決它。恢復一旦完成，帳戶的控制權就換人了。
          </Notice>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href={wallet.manageUrl} target="_blank" rel="noreferrer"><Button>到 CAFECA 查看</Button></a>
          <Button variant="secondary" onClick={refreshWallet}>重新整理狀態</Button>
        </div>
      </Card>
    );
  }

  // ③ 登入了，但沒有簽章通道 → 看得到，動不了
  if (!channelOpen) {
    return (
      <Card title="還不能下單或送出交易">
        <div className="space-y-3 text-sm leading-7 text-ink-200">
          <p>
            你已經登入
            <span className="ml-1 font-mono text-ink-50">{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</span>
            ，持倉與紀錄都看得到。缺的是<b>簽章通道</b>——沒有它，我們沒有辦法請你簽委託單，
            也沒有辦法請你的帳戶送出交易。
          </p>
          <p className="text-ink-300">
            重新登入一次就會徵詢你是否開啟。<b>通道不是授權</b>：每一筆請求都會在 CAFECA 錢包
            顯示我們寫的說明，以及錢包自己解析出來的實際操作，由你確認後才簽。
            你也可以隨時在 CAFECA 的「安全 → 以 CAFECA 登入的網站」把它關掉。
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={login} disabled={!!busy}>{busy ?? "重新登入並開啟通道"}</Button>
          <Button variant="secondary" onClick={recheckChannel}>我已經開了，重新檢查</Button>
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
