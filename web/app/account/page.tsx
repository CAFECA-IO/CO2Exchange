"use client";
import { useState } from "react";
import Link from "next/link";
import { useAccount } from "@/components/AccountProvider";
import { AccountGate } from "@/components/AccountGate";
import { Button, Card, Field, Notice, inputCls } from "@/components/ui";
import { useNow } from "@/lib/client/useNow";

/// 裝置與安全。
///
/// 這一頁回答四個在事故當下才會被問、而那時候已經來不及讀說明書的問題：
///   · 手機掉了，別台還在  → 把它撤掉。即時，不需要任何人。
///   · 全部裝置都掉了      → 走復原：治理方重新驗身分後提案，等 72 小時。
///   · 登入帳號被盜        → 他簽不了字（私鑰在你的裝置裡），但他會看到你的持倉，
///                            也能按凍結。你用手上的 passkey 解凍、改密碼。
///   · passkey 被盜        → 從別台撤掉；來不及就先凍結。
///
/// 所以版面的順序是：出事時先看到的（凍結狀態、復原提案、待核准的裝置）在最上面，
/// 平常管理的（裝置清單）在中間，解釋在最後。急的時候沒有人會往下捲。

const day = (ms: number) => new Date(ms).toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" });

/// 倒數。Date.now() 不在 render 期間呼叫——那是不純的，同一份 props 會畫出不同結果，
/// 也讓伺服器端與瀏覽器端的第一次輸出對不起來。改成掛載後量一次、之後每分鐘更新。
function Countdown({ until }: { until: number }) {
  const now = useNow();
  if (!now) return null; // 伺服器端那一輪還沒有時鐘
  const left = until * 1000 - now;
  if (left <= 0) return <>已可執行</>;
  return <>還有 {Math.floor(left / 3_600_000)} 小時 {Math.floor((left % 3_600_000) / 60_000)} 分</>;
}

export default function AccountPage() {
  const {
    userId, wallet, deviceCredential, thisDeviceActive, busy, refreshWallet,
    requestThisDevice, approveDevice, rejectDevice, removeDevice, freeze, unfreeze, cancelRecovery, forget,
  } = useAccount();
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  async function run(msg: string, fn: () => Promise<unknown>) {
    setErr(null); setOk(null);
    try { await fn(); setOk(msg); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  if (!userId) return <AccountGate />;
  if (!wallet) return <Notice>{busy ?? "讀取錢包狀態中…"}</Notice>;
  if (!wallet.exists) return <AccountGate />;

  const thisKeyId = deviceCredential?.keyId?.toLowerCase();
  const canSign = thisDeviceActive;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold text-ink-50">裝置與安全</h1>
        <p className="max-w-3xl text-sm leading-7 text-ink-200">
          你的錢包 <span className="font-mono text-ink-50">{wallet.address}</span>。
          地址由<b>登入帳號</b>決定——換幾台裝置都是同一個。下面每一把 passkey 都能單獨動用它，
          也都能被撤掉。
        </p>
      </header>

      {/* ── 出事時最先要看到的三件事 ───────────────────────── */}

      {wallet.frozen && (
        <Card title="錢包已凍結">
          <div className="space-y-3 text-sm leading-7 text-ink-200">
            <p>
              目前無法交易、無法註銷。金鑰管理仍然可以做——
              凍結是止血，不該把你自己鎖在門外。
            </p>
            <p className="text-ink-300">
              解凍需要一把<b>還在錢包裡</b>的 passkey。只拿到你登入權的人按得下凍結，
              解不開——這個不對稱是刻意的。
            </p>
          </div>
          <div className="mt-4">
            <Button disabled={!canSign || !!busy} onClick={() => run("已解除凍結", unfreeze)}>
              {busy ?? "用這台裝置解除凍結"}
            </Button>
            {!canSign && <p className="mt-2 text-xs text-warn">這台裝置沒有有效的 passkey，換一台在清單裡的裝置操作。</p>}
          </div>
        </Card>
      )}

      {wallet.recovery && (
        <Card title="有人正在申請把一把新 passkey 加進你的錢包">
          <Notice kind="warn">
            <b>這是你申請的嗎？</b> 不是的話，立刻否決，然後凍結錢包並更換登入密碼。
          </Notice>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-300">申請的裝置名稱</dt><dd className="text-ink-50">{wallet.recovery.label || "（未命名）"}</dd>
            <dt className="text-ink-300">生效時間</dt>
            <dd className="text-ink-50">{day(wallet.recovery.executeAfter * 1000)}（<Countdown until={wallet.recovery.executeAfter} />）</dd>
          </dl>
          <p className="mt-3 text-sm leading-7 text-ink-300">
            復原提案只有治理方能提出，而且要在鏈下重新通過身分驗證。
            等待期的用意就是這個：讓真正的持有人有時間說「不是我」。
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button disabled={!canSign || !!busy} onClick={() => run("已否決這個復原提案", cancelRecovery)}>
              {busy ?? "否決"}
            </Button>
            {!wallet.frozen && (
              <Button variant="secondary" disabled={!!busy} onClick={() => run("已凍結", freeze)}>同時凍結錢包</Button>
            )}
          </div>
        </Card>
      )}

      {wallet.pendingDevices.length > 0 && (
        <Card title="等待核准的新裝置">
          <p className="text-sm leading-7 text-ink-200">
            有人在另一台裝置上用你的登入帳號建了一把 passkey，要求加入這個錢包。
            <b>不是你的話請拒絕</b>——這是帳號被盜最早的徵兆，拒絕之後請一併凍結並改密碼。
          </p>
          <ul className="mt-3 space-y-2">
            {wallet.pendingDevices.map((d) => (
              <li key={d.keyId} className="flex flex-wrap items-center justify-between gap-2 rounded-[--radius-ctl] border border-warn/40 bg-warn/5 px-3 py-2">
                <span className="text-sm text-ink-50">
                  {d.label}
                  <span className="ml-2 text-xs text-ink-300">{day(d.requestedAt)}</span>
                  {d.keyId.toLowerCase() === thisKeyId && <span className="ml-2 text-xs text-tide">（就是這台裝置）</span>}
                </span>
                <span className="flex gap-2">
                  <Button
                    disabled={!canSign || !!busy}
                    onClick={() => run("已核准，這台裝置現在可以簽字了", () => approveDevice(d.keyId, d.publicKey, d.label))}
                  >
                    核准
                  </Button>
                  <Button variant="secondary" disabled={!!busy} onClick={() => run("已拒絕", () => rejectDevice(d.keyId))}>
                    拒絕
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          {!canSign && <p className="mt-2 text-xs text-warn">核准需要一把已經在錢包裡的 passkey，這台裝置沒有。</p>}
        </Card>
      )}

      {/* ── 平常的管理 ───────────────────────── */}

      <Card
        title={`可以動用這個錢包的 passkey（${wallet.keys.length}）`}
        action={<Button variant="ghost" onClick={refreshWallet}>重新整理</Button>}
      >
        <ul className="space-y-2">
          {wallet.keys.map((k) => {
            const isThis = k.keyId.toLowerCase() === thisKeyId;
            const last = wallet.keys.length === 1;
            return (
              <li key={k.keyId} className="flex flex-wrap items-center justify-between gap-2 rounded-[--radius-ctl] border border-ink-500 px-3 py-2">
                <span className="text-sm">
                  <span className="text-ink-50">{k.label}</span>
                  {isThis && <span className="ml-2 rounded-[--radius-ctl] bg-tide/15 px-1.5 py-0.5 text-xs text-tide">這台裝置</span>}
                  <span className="ml-2 font-mono text-xs text-ink-300">{k.keyId.slice(0, 10)}…</span>
                  <span className="ml-2 text-xs text-ink-300">加入於 {day(k.addedAt * 1000)}</span>
                </span>
                <Button
                  variant="secondary"
                  disabled={!canSign || last || !!busy}
                  title={last ? "這是最後一把，撤掉錢包就永遠動不了" : undefined}
                  onClick={() => run(`已移除「${k.label}」`, () => removeDevice(k.keyId))}
                >
                  {isThis ? "撤銷這台裝置" : "撤銷"}
                </Button>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs leading-6 text-ink-300">
          最後一把 passkey 撤不掉：那是一個按錯一次就無法挽回的按鈕，所以合約直接不提供。
          要換裝置請先加新的，再撤舊的。
        </p>
      </Card>

      <Card title="新增一台裝置">
        {canSign ? (
          <p className="text-sm leading-7 text-ink-200">
            要加的是<b>另一台</b>裝置的話，請在那台裝置上用同一個帳號登入，
            按「申請加入」，然後回到這一頁核准。passkey 存在裝置的安全元件裡，
            沒辦法從這裡遠端替它建立。
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm leading-7 text-ink-200">
              這台裝置還不能簽字。在這裡建一把 passkey 並送出申請，然後用一台
              已經在清單裡的裝置核准。
            </p>
            <div className="flex max-w-sm items-end gap-2">
              <Field label="這台裝置叫什麼（之後要靠它認出來）">
                <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：公司筆電" />
              </Field>
              <Button disabled={!!busy} onClick={() => run("已送出申請，請用現有裝置核准", () => requestThisDevice(label))}>
                {busy ?? "申請加入"}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ── 掛失 ───────────────────────── */}

      <Card title="掛失">
        <div className="space-y-3 text-sm leading-7 text-ink-200">
          <p>
            裝置被拿走、或懷疑登入帳號被盜——先凍結。凍結之後任何交易都會被擋下，
            但你仍然可以撤掉那把有問題的 passkey、加入新裝置、再解凍。
          </p>
          <p className="text-ink-300">
            凍結只要登得進來就按得下去，因為需要它的那一刻你手上多半已經沒有那台裝置了。
            解凍則需要一把現存 passkey。
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" disabled={wallet.frozen || !!busy} onClick={() => run("已凍結", freeze)}>
            {wallet.frozen ? "已凍結" : "凍結我的錢包"}
          </Button>
          <Button variant="ghost" onClick={() => run("已移除這台裝置在本機的紀錄", async () => forget())}>
            移除此裝置的紀錄
          </Button>
        </div>
        <p className="mt-2 text-xs text-ink-300">
          「移除此裝置的紀錄」只清掉這個瀏覽器記著的東西，<b>不會</b>撤銷鏈上的金鑰。
          真的要撤銷請用上面清單裡的「撤銷」。
        </p>
      </Card>

      {/* ── 所有裝置都遺失 ───────────────────────── */}

      <Card title="所有裝置都遺失了怎麼辦">
        <div className="space-y-3 text-sm leading-7 text-ink-200">
          <p>
            一把 passkey 都不剩時，沒有任何人能代你簽字——包括平台。這時走復原程序：
          </p>
          <ol className="space-y-1.5 border-l-2 border-ink-500 pl-4 text-ink-300">
            <li>① 與平台聯絡並<b>重新通過身分驗證</b>（與當初 KYC 同一套程序，不是「登入一次」）。</li>
            <li>② 治理方多簽提案，把你新裝置上的 passkey 加進這個錢包。</li>
            <li>③ 等待 {Math.round((wallet.recoveryDelay || 259200) / 3600)} 小時。期間任何一把現存 passkey 都能否決——這是給「其實你沒掉」的情況留的煞車。</li>
            <li>④ 期滿執行。<b>地址不變</b>，持倉、憑證、交易紀錄都還在。</li>
          </ol>
          <p className="text-ink-300">
            平台單方面做不到這件事：提案要治理多簽，執行要等過等待期，而且全程都在鏈上，
            任何人都查得到。
          </p>
        </div>
        <div className="mt-4">
          <Link href="/agreements"><Button variant="secondary">相關條款</Button></Link>
        </div>
      </Card>

      {err && <Notice kind="error">{err}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}
    </div>
  );
}
