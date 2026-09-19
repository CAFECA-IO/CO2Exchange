"use client";
import { useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { useAccount } from "@/components/AccountProvider";
import { Button, Card, Field, Notice, inputCls } from "@/components/ui";
import { MarketPanel } from "@/components/MarketPanel";
import Link from "next/link";

/// 專案生命週期。本平台只負責最後兩段（交易、註銷）—— 前面七段在主管機關與查驗機構手上。
const LIFECYCLE = [
  { n: "1", title: "選定方法學", body: "採用主管機關認可的減量方法學，決定這類減量要怎麼算。", who: "開發者" },
  { n: "2", title: "專案設計", body: "界定專案邊界與排放源、建立基線情境、論證外加性、訂定監測計畫。", who: "開發者", iso: "ISO 14064-2" },
  { n: "3", title: "確證 Validation", body: "查驗機構審查專案計畫書：基線合不合理、外加性站不站得住、監測計畫可不可行。", who: "查驗機構", iso: "ISO 14064-3" },
  { n: "4", title: "註冊", body: "主管機關核准並登錄專案，計入期自此起算。", who: "主管機關" },
  { n: "5", title: "監測 Monitoring", body: "依監測計畫蒐集數據，記錄實際運轉情形。", who: "開發者", iso: "ISO 14064-2" },
  { n: "6", title: "查證 Verification", body: "查驗機構查核監測期間的實際減量，出具查證聲明。", who: "查驗機構", iso: "ISO 14064-3" },
  { n: "7", title: "核發額度", body: "主管機關依查證結果核發減量額度，一單位代表一公噸二氧化碳當量。", who: "主管機關" },
  { n: "8", title: "交易", body: "額度持有人掛單出售，個人、機構或其他企業買入。", who: "本平台", here: true },
  { n: "9", title: "註銷 Retirement", body: "買方註銷額度，額度永久退出流通，取得可附於申報文件的憑證。", who: "本平台", here: true },
];

const ISO_PARTS = [
  { part: "ISO 14064-1", level: "組織層級", what: "組織溫室氣體排放與移除的量化與報告（盤查）。" },
  { part: "ISO 14064-2", level: "專案層級", what: "減量專案的量化、監測與報告。要求界定排放源、匯與貯存庫，建立基線情境，並完整規劃專案。", highlight: true },
  { part: "ISO 14064-3", level: "查驗", what: "溫室氣體聲明的確證與查證原則與要求，適用於組織、專案與產品三種聲明。" },
];

function Section({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8">
      <p className="text-xs font-medium uppercase tracking-wider text-tide">{eyebrow}</p>
      <h2 className="mt-1 font-display text-xl font-semibold tracking-tight text-ink-50">{title}</h2>
      <div className="mt-4 space-y-4 text-sm leading-7 text-ink-200">{children}</div>
    </section>
  );
}

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
    <div className="space-y-14">
      {/* ── 行情：進站第一眼就是市場 ─────────────────────────────── */}
      <MarketPanel />

      {/* ── Hero + 登入 ────────────────────────────────────────────── */}
      <div className="grid gap-6 md:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          <h1 className="font-display text-3xl font-bold tracking-tight text-ink-50">減量額度登錄、交易與註銷平台</h1>
          <p className="text-sm leading-7 text-ink-200">
            企業執行溫室氣體自願減量專案、通過第三方查驗後取得減量額度。本平台就是這些額度的登錄簿與交易場所——
            查驗機構在鏈上簽章核發，額度可販售給個人、機構或其他企業，買方註銷後取得可附於申報文件的憑證。
          </p>
          <p className="text-sm leading-7 text-ink-200">
            每一單位額度都能回溯到它的專案、監測期間與查驗簽章；註銷之後永久退出流通，無法再被轉讓或重複主張。
          </p>
          <div className="flex flex-wrap gap-2 pt-1 text-xs">
            <a href="#project" className="rounded-full border border-ink-500 px-3 py-1 text-ink-300 transition hover:border-tide/60 hover:text-ink-50">什麼是自願減量專案</a>
            <a href="#paris" className="rounded-full border border-ink-500 px-3 py-1 text-ink-300 transition hover:border-tide/60 hover:text-ink-50">巴黎協定第六條</a>
            <a href="#iso" className="rounded-full border border-ink-500 px-3 py-1 text-ink-300 transition hover:border-tide/60 hover:text-ink-50">ISO 14064</a>
            <a href="#lifecycle" className="rounded-full border border-ink-500 px-3 py-1 text-ink-300 transition hover:border-tide/60 hover:text-ink-50">專案生命週期</a>
          </div>
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
                  <p className="text-xs text-ink-300">在 .env.local 設定 AUTH_GOOGLE_ID / AUTH_APPLE_ID 後會出現 Google / Apple 登入。</p>
                )}
              </div>
            </Card>
          ) : !credential ? (
            <Card title="建立鏈上帳戶">
              <p className="mb-3 text-sm text-ink-200">已登入：{session.user.email}。接下來用 passkey 建立帳戶；地址由公鑰決定，換裝置後同一把 passkey 仍對到同一地址。</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => run(createAccount)} disabled={!!busy}>{busy ?? "建立新帳戶（passkey）"}</Button>
                <Button variant="secondary" onClick={() => run(useExistingPasskey)} disabled={!!busy}>我已有 passkey</Button>
              </div>
            </Card>
          ) : (
            <Card title="帳戶已就緒">
              <dl className="space-y-1 text-sm">
                <div><dt className="text-ink-300">登入</dt><dd className="text-ink-50">{session.user.email}</dd></div>
                <div><dt className="text-ink-300">鏈上地址</dt><dd className="font-mono break-all text-ink-50">{credential.address}</dd></div>
              </dl>
              <div className="mt-4 flex gap-2">
                <Link href="/kyc"><Button>下一步：身分驗證</Button></Link>
                <Button variant="secondary" onClick={forget}>移除此裝置的帳戶紀錄</Button>
              </div>
            </Card>
          )}
          {err && <Notice kind="error">{err}</Notice>}

          <Card title="開始使用">
            <ol className="space-y-2 text-sm text-ink-200">
              <li><b>1. 登入</b> — Apple / Google 帳號只用來建立 session。</li>
              <li><b>2. 建立帳戶</b> — 用裝置的 passkey（FaceID / TouchID）當鏈上帳戶的唯一金鑰，沒有助記詞、沒有第三方託管。</li>
              <li><b>3. 身分驗證</b> — 以工商憑證 / 自然人憑證綁定帳戶地址（Phase 0 為模擬）。</li>
              <li><b>4. 購買並註銷</b> — 從企業掛單或流動性池買入，註銷後取得憑證。</li>
            </ol>
            {config && (
              <p className="mt-3 text-xs text-ink-300">鏈 ID {config.deployment.chainId} · RPC {config.rpcUrl}</p>
            )}
          </Card>
        </div>
      </div>

      {/* ── 什麼是自願減量專案 ──────────────────────────────────────── */}
      <Section id="project" eyebrow="本平台交易的標的" title="什麼是溫室氣體自願減量專案">
        <p>
          自願減量專案是一件有明確邊界的事：某個組織執行一項本來不會發生的減量措施——把柴油發電換成屋頂太陽能、
          回收製程廢熱、改善廢棄物處理——並且用可被第三方查核的方式，證明它比「什麼都不做」少排了多少溫室氣體。
          這個「少排的量」經過查驗與核准之後，就成為可以持有、移轉與註銷的<b>減量額度</b>，一單位代表一公噸二氧化碳當量（tCO<sub>2</sub>e）。
        </p>
        <p>
          關鍵在於「本來不會發生」。一個專案要能核發額度，必須先回答四個問題，而這四個問題正是整套標準與查驗制度存在的理由：
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ["基線情境 Baseline", "如果沒有這個專案，這裡本來會排多少？額度算的是實際排放與基線的差額，所以基線訂得對不對，直接決定額度是真是假。"],
            ["外加性 Additionality", "這項減量是不是因為專案才發生的？如果法規本來就強制、或財務上本來就會做，那就沒有外加性，不該核發額度。"],
            ["洩漏 Leakage", "減量有沒有只是被推到別處去？專案邊界外增加的排放必須扣回來。"],
            ["重複計算 Double counting", "同一噸減量有沒有被兩個人同時主張？登錄簿、唯一序號與註銷紀錄就是為了擋這件事。"],
          ].map(([t, d]) => (
            <div key={t} className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
              <h3 className="text-sm font-semibold text-ink-50">{t}</h3>
              <p className="mt-1 text-sm leading-6 text-ink-300">{d}</p>
            </div>
          ))}
        </div>
        <p>
          在台灣，這件事的法律依據是<b>氣候變遷因應法</b>：第 25 條規定事業或各級政府得提出自願減量專案，
          執行減量措施後向中央主管機關申請核准取得減量額度；第 22 條要求查驗機構須經認證並取得許可；
          第 26 條列出額度的法定用途；第 27 條則是額度的移轉與交易——<b>也就是本平台所在的位置</b>。
        </p>
      </Section>

      {/* ── 巴黎協定 ───────────────────────────────────────────────── */}
      <Section id="paris" eyebrow="國際框架" title="巴黎協定與第六條的碳市場機制">
        <p>
          <b>巴黎協定</b>（Paris Agreement，2015 年 COP21 通過）取代京都議定書成為現行的全球氣候協議。
          它與京都議定書最大的不同在於：不再由上而下分配各國的減量義務，而是各國自行提出<b>國家自定貢獻</b>（NDC）並定期檢討加嚴。
          目標是將全球升溫控制在遠低於 2°C、並努力限制在 1.5°C 以內。
        </p>
        <p>
          協定的<b>第六條</b>處理的是：各國之間可以怎麼合作減量，以及減量成果要怎麼移轉才不會被重複計算。它分成三條路徑：
        </p>
        <div className="space-y-3">
          {[
            ["第 6.2 條", "合作方法（Cooperative Approaches）", "國與國之間直接移轉「國際移轉減緩成果」（ITMOs）。移出方必須做相應調整（corresponding adjustment），把移轉出去的量加回自己的排放帳上，確保同一噸減量不會被買賣雙方同時計入各自的 NDC。"],
            ["第 6.4 條", "巴黎協定額度機制（PACM）", "聯合國層級的集中式額度機制，由 12 人組成的第 6.4 條監督機構管理，依 Decision 3/CMA.3 建立，接續清潔發展機制（CDM）的角色，並處理既有 CDM 專案的轉換。專案經註冊、查證後核發額度。"],
            ["第 6.8 條", "非市場方法", "不涉及額度交易的合作，例如資金支援、技術移轉與能力建構。"],
          ].map(([no, name, body]) => (
            <div key={no} className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="rounded bg-tide px-2 py-0.5 text-xs font-medium text-ink-900">{no}</span>
                <h3 className="text-sm font-semibold text-ink-50">{name}</h3>
              </div>
              <p className="mt-2 text-sm leading-6 text-ink-300">{body}</p>
            </div>
          ))}
        </div>
        <Notice kind="info">
          <b>本平台與第六條的關係：</b>台灣的自願減量專案屬於<b>國內</b>制度，依氣候變遷因應法核發，
          目前不是第 6.2 條下的 ITMOs、也不是第 6.4 條核發的額度，因此不涉及相應調整。
          第六條在這裡的意義是<b>制度藍本</b>——專案註冊、監測、查證、唯一序號、登錄簿、註銷這一整套防重複計算的作法，
          都是國際碳市場二十年累積下來的共識，本平台的鏈上設計直接對應這套流程。
          未來若要與國際機制銜接，缺的是相應調整與國家授權，不是資料結構。
        </Notice>
      </Section>

      {/* ── ISO 14064 ─────────────────────────────────────────────── */}
      <Section id="iso" eyebrow="量化與查驗標準" title="ISO 14064：把「減了多少」變成可查核的數字">
        <p>
          ISO 14064 是溫室氣體量化與查驗的國際標準，分成三部分。本平台交易的額度，其可信度直接建立在其中兩部分上：
          <b>14064-2 決定減量怎麼算</b>，<b>14064-3 決定誰來查、怎麼查</b>。
        </p>
        <div className="overflow-hidden rounded-[--radius-card] border border-ink-500">
          <table className="w-full text-sm">
            <thead className="bg-ink-600 text-left text-xs uppercase tracking-wider text-ink-300">
              <tr><th className="px-4 py-2 font-medium">標準</th><th className="px-4 py-2 font-medium">層級</th><th className="px-4 py-2 font-medium">內容</th></tr>
            </thead>
            <tbody className="divide-y divide-ink-500 bg-ink-700">
              {ISO_PARTS.map((p) => (
                <tr key={p.part} className={p.highlight ? "bg-tide/10" : undefined}>
                  <td className="px-4 py-3 align-top font-medium whitespace-nowrap">{p.part}</td>
                  <td className="px-4 py-3 align-top whitespace-nowrap text-ink-300">{p.level}</td>
                  <td className="px-4 py-3 align-top leading-6 text-ink-300">{p.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <b>ISO 14064-2:2019</b>（第 2 版，2019 年 4 月發布，2024 年確認續用）規範專案層級的量化、監測與報告：
          要求識別相關的溫室氣體排放源、匯與貯存庫，建立基線情境，並完整規劃專案活動。
          換句話說，前一節那四個問題——基線、外加性、洩漏、重複計算——就是這份標準要求專案必須交代清楚的東西。
        </p>
        <p>
          <b>ISO 14064-3:2019</b> 則規範溫室氣體聲明的確證（validation，事前審查計畫）與查證（verification，事後查核實績）。
          一個專案在生命週期中會被查兩次：計畫階段確證、監測期滿查證。這也是為什麼查驗機構的獨立性與許可資格
          （氣候變遷因應法第 22 條）是整個制度的信任根基。
        </p>
        <p className="text-xs text-ink-300">
          ISO 14060 系列是「GHG 制度中立」的——若另有適用的溫室氣體管理制度，該制度的要求會疊加在 ISO 標準之上。
          台灣的情形就是：ISO 14064-2／-3 提供方法與查驗框架，氣候變遷因應法與其子法提供法律效力與主管機關核准程序。
        </p>
      </Section>

      {/* ── 生命週期 ──────────────────────────────────────────────── */}
      <Section id="lifecycle" eyebrow="從減量到註銷" title="專案生命週期，以及本平台在哪一段">
        <p>
          一個自願減量專案從構想到額度被註銷，要經過九個階段。前七段發生在平台之外——由專案開發者、查驗機構與主管機關完成；
          本平台承接的是最後兩段，也是額度真正流動與消滅的地方。
        </p>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {LIFECYCLE.map((s) => (
            <li
              key={s.n}
              className={`rounded-lg border p-4 ${
                s.here
                  ? "border-tide/70 bg-tide/10"
                  : "border-ink-500 bg-ink-700"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  s.here ? "bg-tide text-ink-900" : "bg-ink-600 text-ink-200"
                }`}>{s.n}</span>
                <h3 className="text-sm font-semibold text-ink-50">{s.title}</h3>
              </div>
              <p className="mt-2 text-sm leading-6 text-ink-300">{s.body}</p>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                <span className={`rounded px-1.5 py-0.5 ${
                  s.here ? "bg-tide text-ink-900" : "bg-ink-600 text-ink-300"
                }`}>{s.who}</span>
                {s.iso && <span className="rounded bg-ink-600 px-1.5 py-0.5 text-ink-300">{s.iso}</span>}
              </div>
            </li>
          ))}
        </ol>
        <p>
          鏈上對應：專案與批次寫進<b>登錄層</b>（不可升級，確保額度歷史不可竄改）；查驗機構的核發是一筆帶簽章的鏈上交易，
          序號唯一且不可重複；<b>交易</b>走企業掛單市場；<b>註銷</b>會銷毀額度並鑄造一張不可移轉的憑證 NFT，
          記載受益人、用途與數量。憑證 PDF 的 SHA-256 也寫在鏈上，任何人都能自行重算比對。
        </p>
      </Section>

      {/* ── 額度用途與邊界 ─────────────────────────────────────────── */}
      <Section id="use" eyebrow="能用在哪、不能用在哪" title="額度的用途與法律邊界">
        <p>
          氣候變遷因應法第 26 條列出減量額度的法定用途，包括溫室氣體<b>增量抵換</b>、<b>扣除排放量</b>、
          <b>抵銷超額量</b>等。實際可用的比例、條件與期限，依中央主管機關公告辦理。
        </p>
        <Notice kind="info">
          <b>關於 CBAM，必須講清楚：</b>歐盟碳邊境調整機制自 2026 年 1 月 1 日起進入正式期，
          進口商須購買並繳銷 CBAM 憑證，其價格連動歐盟排放交易體系（EU ETS）的配額拍賣價。
          CBAM 承認的是<b>在生產國實際已支付的碳價</b>，並非自願性抵換額度。
          因此本平台不將「用於 CBAM 扣抵」列為額度用途；若未來規則變動，會依主管機關與歐盟公告更新。
        </Notice>
        <p className="text-xs leading-6 text-ink-300">
          本站目前為 Phase 0 展示版本：身分驗證、查驗機構簽章與結算幣皆為模擬，額度不具法律效力，不得作為任何申報依據。
          正式營運的前提是主管機關認可、查驗機構自行簽章，以及金融機構提供的結算工具。
        </p>
      </Section>
    </div>
  );
}
