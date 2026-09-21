"use client";
import { useState } from "react";
import Link from "next/link";
import { useAccount } from "./AccountProvider";
import { Button, Card, Notice } from "./ui";
import { NO_LOGIN_BODY, NO_LOGIN_TITLE, hasLogin } from "@/lib/login";

/// 進入內頁前的門檻畫面。
///
/// 為什麼需要它：「登入」與「鏈上帳戶」是兩件不同的事，但舊版的文案把它們講成同一件。
/// 使用者用 Apple / Google 登入後，右上角顯示「登出」；此時若這台裝置還沒有 passkey，
/// 內頁只會冒出一句「請先在首頁建立鏈上帳戶」——看起來就是「叫我登入，又說我已登入」，
/// 而且把人趕去首頁才能動作。
///
/// 現在原地說明兩者的差別，並且把該按的按鈕放在同一個畫面上。
export function AccountGate() {
  const { userId, credential, config, busy, unbound, createAccount, useExistingPasskey } = useAccount();
  const [err, setErr] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
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
          登入只用來建立這個瀏覽器的 session，不是你的鏈上身分。
          登入之後還要在這台裝置建立一次鏈上帳戶（passkey）。
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/"><Button>回首頁登入</Button></Link>
        </div>
      </Card>
    );
  }

  // ② 有 session，但這台裝置沒有 passkey
  if (!credential) {
    return (
      <Card title="這台裝置還沒有鏈上帳戶">
        <div className="space-y-3 text-sm leading-7 text-ink-200">
          <p>
            你<b>已經登入</b>了（右上角所以顯示「登出」），但登入和鏈上帳戶是兩件事：
          </p>
          <ul className="space-y-1.5 border-l-2 border-ink-500 pl-4">
            <li><b>登入</b>——Apple / Google 帳號，只是這個瀏覽器的 session。</li>
            <li><b>鏈上帳戶</b>——由這台裝置的 passkey（Face ID / Touch ID）決定，地址從公鑰算出來。金鑰只在裝置上，平台拿不到，所以換一台裝置或清掉瀏覽器資料之後，要再綁一次。</li>
          </ul>
          {unbound ? (
            <Notice kind="error">
              這台裝置原本綁定的帳戶，在目前的合約部署上不存在，自動重新綁定也沒有成功，已經解除綁定。
              如果鏈剛重開過，這是正常的：底下用同一把 passkey 重新綁定即可，不需要重新註冊。
            </Notice>
          ) : (
            <p className="text-ink-300">
              第一次使用請選「建立新帳戶」；在別台裝置建過、或這台裝置清過資料，選「我已有 passkey」。
            </p>
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => run(createAccount)} disabled={!!busy}>{busy ?? "建立新帳戶（passkey）"}</Button>
          <Button variant="secondary" onClick={() => run(useExistingPasskey)} disabled={!!busy}>我已有 passkey</Button>
        </div>
        {err && <div className="mt-3"><Notice kind="error">{err}</Notice></div>}
      </Card>
    );
  }

  // ③ 有帳戶，但設定還沒讀回來（或鏈連不上）
  return (
    <Notice>
      {busy ?? (config ? "讀取中…" : "讀取鏈上設定中…若一直停在這裡，請確認節點已啟動。")}
    </Notice>
  );
}
