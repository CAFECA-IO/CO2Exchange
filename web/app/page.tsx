"use client";
import { useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { useAccount } from "@/components/AccountProvider";
import { Button, Card, Field, Notice, inputCls } from "@/components/ui";
import { MarketPanel } from "@/components/MarketPanel";
import { MarketOverview } from "@/components/MarketOverview";
import Link from "next/link";

/// 這頁的說明文字刻意寫得像講給人聽，而不是抄法條：
/// 每一個抽象名詞後面都跟一個具體例子，並且從頭到尾用同一家金屬扣件廠當主角，
/// 讀者不必記住五個互不相干的假設。法規與標準的引用維持精確，白話只用在解釋。

/// 專案生命週期。本平台只負責最後兩段——前面七段在開發者、查驗機構與主管機關手上。
const LIFECYCLE = [
  { n: "1", title: "選定方法學", body: "先找到主管機關公告的減量方法。扣件廠走的是鍋爐與加熱爐燃料轉換、廢熱回收這一類；方法決定了公式、參數與要監測哪些東西，不能自己發明算法。", who: "開發者" },
  { n: "2", title: "專案設計", body: "畫出邊界（哪幾座熱處理爐、哪一條表面處理線算在內）、寫下基線情境、論證外加性，並把監測計畫訂成可執行的文件：瓦斯表與油量表裝在哪、多久抄一次、產量紀錄誰保管。", who: "開發者", iso: "ISO 14064-2" },
  { n: "3", title: "確證 Validation", body: "開工前審圖。查驗機構逐項審查計畫書：基線合不合理、外加性站不站得住、監測計畫做不做得到。不同意就退回修改。", who: "查驗機構", iso: "ISO 14064-3" },
  { n: "4", title: "註冊", body: "主管機關核准並登錄專案，計入期從這一刻起算。此前已經做完的事情不能回頭認列。", who: "主管機關" },
  { n: "5", title: "監測 Monitoring", body: "新爐開始運轉，照計畫抄表、留紀錄，並同時記錄產量——只有「同樣產量下少燒多少」才算數。瓦斯表故障又沒有補救程序，那段期間的減量很可能就算不進去。", who: "開發者", iso: "ISO 14064-2" },
  { n: "6", title: "查證 Verification", body: "完工後驗收。監測期滿，查驗機構核對數據、查看現場，出具查證聲明：這段期間確實減了這麼多。", who: "查驗機構", iso: "ISO 14064-3" },
  { n: "7", title: "核發額度", body: "主管機關依查證結果核發。1,000 公噸就是 1,000 單位，每一批帶著唯一序號，之後不論轉手幾次都查得回來。", who: "主管機關" },
  { n: "8", title: "交易", body: "額度持有人在市場掛單出售，個人、機構或其他企業買入。價格由買賣雙方決定，成交紀錄公開可查。", who: "本平台", here: true },
  { n: "9", title: "註銷 Retirement", body: "買方註銷額度，這一公噸永久退出流通，不能再轉讓、也不能再被任何人主張，並換得一張載明受益人與用途的憑證。", who: "本平台", here: true },
];

const ISO_PARTS = [
  { part: "ISO 14064-1", level: "量一整間公司", what: "組織層級的盤查：這間公司一年排了多少、移除了多少，怎麼算、怎麼報。" },
  { part: "ISO 14064-2", level: "量一個專案減了多少", what: "專案層級的量化、監測與報告。要求把排放源、匯與貯存庫列清楚，建立基線情境，並完整規劃專案活動。扣件廠那 1,000 公噸走的就是這一部。", highlight: true },
  { part: "ISO 14064-3", level: "規定誰來當公證人", what: "確證與查證的原則與要求：查驗機構該查什麼、查到什麼程度、怎麼出具聲明。組織、專案、產品三種聲明都適用。" },
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

/// 舉例框。深色模式下只用 ink-500 當邊框（唯一該用的線色），不放亮白裝飾線。
function Example({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[--radius-card] border border-ink-500 bg-ink-600 p-4">
      <p className="text-xs font-medium tracking-wider text-tide">舉例｜{title}</p>
      <div className="mt-2 space-y-2 text-sm leading-7 text-ink-200">{children}</div>
    </div>
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
          <h1 className="font-display text-3xl font-bold tracking-tight text-ink-50">碳權交易所</h1>
          <p className="text-sm leading-7 text-ink-200">
            一家工廠少排了一公噸二氧化碳，怎麼證明？證明完了之後，這一公噸要怎麼變成別人可以買的東西？
            買走的人用掉之後，又怎麼確定同一公噸不會被第二個人再用一次？
            這三個問題構成整套碳權制度，本平台負責其中最後兩段：<b>交易</b>，以及<b>註銷</b>。
          </p>
          <p className="text-sm leading-7 text-ink-200">
            額度由查驗機構在鏈上簽章核發，每一單位都能回溯到它的專案、監測期間與那一筆簽章；
            買方註銷之後拿到一張不能轉讓的憑證，那一公噸從此退出流通。
          </p>
          <p className="text-sm leading-7 text-ink-200">
            本站是<b>國際運行平台</b>，同時交易多個轄區核發的減量額度。每一批額度都標明<b>核發國</b>——
            它的法律效力、可用途徑、移轉與註銷程序，一律依<b>核發國</b>的法規與該國官方登錄簿辦理，
            不會因為在本站交易而改變。本站與用戶之間的平台服務關係，則依平台所在地（中華民國）法律——
            這是<b>兩個不同的層次</b>，不要混在一起看。
          </p>
          <p className="text-sm leading-7 text-ink-200">
            一批額度能拿來做什麼，取決於兩件事：<b>誰核發的</b>，以及<b>你要在哪裡申報</b>。
            同一批日本 J-Credit，在日本、在韓國、在臺灣的待遇並不一樣；規則寫在各該國的法律裡，不在交易所的條款裡。
            所以本站在每一筆掛單、每一次下單確認、每一張憑證上都標明核發國與機制——
            判斷留給你和你的顧問，資訊由我們負責講清楚。
          </p>
          <p className="text-sm leading-7 text-ink-200">
            已開放：日本 J-Credit、韓國 KOC、泰國 T-VER、印尼 SPE-GRK、澳洲 ACCU、臺灣 TCER。
            碳權託管於各國政府的官方登錄簿帳戶、入金託管於信託專戶，
            每月 5 日<Link className="text-tide underline" href="/custody">公開對帳</Link>。
          </p>
          <div className="flex flex-wrap gap-2 pt-1 text-xs">
            <a href="#project" className="rounded-full border border-ink-500 px-3 py-1 text-ink-300 transition hover:border-tide/60 hover:text-ink-50">什麼是自願減量專案</a>
            <a href="#paris" className="rounded-full border border-ink-500 px-3 py-1 text-ink-300 transition hover:border-tide/60 hover:text-ink-50">巴黎協定第六條</a>
            <a href="#iso" className="rounded-full border border-ink-500 px-3 py-1 text-ink-300 transition hover:border-tide/60 hover:text-ink-50">ISO 14064</a>
            <a href="#lifecycle" className="rounded-full border border-ink-500 px-3 py-1 text-ink-300 transition hover:border-tide/60 hover:text-ink-50">專案生命週期</a>
            <a href="#use" className="rounded-full border border-ink-500 px-3 py-1 text-ink-300 transition hover:border-tide/60 hover:text-ink-50">能用在哪</a>
            <a href="#local" className="rounded-full border border-ink-500 px-3 py-1 text-ink-300 transition hover:border-tide/60 hover:text-ink-50">為什麼優先買在地</a>
            <a href="#markets" className="rounded-full border border-ink-500 px-3 py-1 text-ink-300 transition hover:border-tide/60 hover:text-ink-50">亞太各國額度</a>
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
              <li><b>4. 買進並註銷</b> — 從掛單簿挑專案，或用市價即時成交；要用掉時註銷並取得憑證。</li>
            </ol>
            {config && (
              <p className="mt-3 text-xs text-ink-300">鏈 ID {config.deployment.chainId} · RPC {config.rpcUrl}</p>
            )}
          </Card>
        </div>
      </div>

      {/* ── 市場概況：數字與圖，回答「這個市場有多大」 ─────────────── */}
      <MarketOverview />

      {/* ── 什麼是自願減量專案 ──────────────────────────────────────── */}
      <Section id="project" eyebrow="本平台交易的標的" title="什麼是自願減量專案：從一家扣件廠說起">
        <Example title="一家扣件廠的 1,000 公噸">
          <p>
            高雄岡山一家做螺絲、螺帽的金屬扣件廠。螺絲要夠硬，得先進熱處理爐退火、淬火——
            這是全廠最耗能的一段，爐子原本燒重油，一年約一千公秉。
          </p>
          <p>
            重油每公秉大約排三公噸二氧化碳，所以熱處理這一段的基線是 <b>一年約 3,000 公噸</b>。
            廠方把爐子改燒天然氣，同時在排氣口加裝廢熱回收，把餘熱拿去預熱進料。
            同樣的產量，改完之後約排 2,000 公噸——<b>一年少排約 1,000 公噸二氧化碳當量</b>。
          </p>
          <p>
            這 1,000 公噸經過查驗與核准之後，變成 1,000 單位減量額度。
            <b>一單位＝一公噸二氧化碳當量（tCO<sub>2</sub>e）</b>，本平台買賣的就是這種東西。
            （數字為示意，實際減量依方法學的公式與查證結果計算。）
          </p>
        </Example>
        <p>
          但「少排多少」不是自己說了算。同樣一次爐子換燃料，有人誠實算出 1,000 公噸，也有人可以算成 3,000 公噸。
          要能核發額度，得先過四關——這四關就是整套標準與查驗制度存在的理由：
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ["基線 Baseline", "如果沒做這件事，這裡本來會排多少？", "扣件廠的基線是「爐子繼續燒重油」，額度算的是基線與實際的差。如果基線寫成「反正天然氣管線接來了就會換」，減量就變成零。基線訂得對不對，直接決定額度是真是假。"],
            ["外加性 Additionality", "這件事，是因為專案才發生的嗎？", "法規本來就強制要裝的設備不算；已經申請綠電憑證（T-REC）賣掉的那幾度太陽能，環境效益已經被憑證買走，不能再拿來算一次額度。自願減量專案明文排除這兩種情形。"],
            ["洩漏 Leakage", "減量有沒有只是搬到隔壁去？", "扣件業的熱處理本來就常外包。如果廠方乾脆把熱處理交給隔壁的熱處理廠，自己的帳面漂亮了，總量其實沒少。專案邊界外因此增加的排放，要從減量裡扣回來。"],
            ["重複計算 Double counting", "同一公噸，有沒有被兩個人同時主張？", "同一批額度先賣給 A 公司抵碳費，又拿去跟客戶宣稱「本廠螺絲碳中和」——這就是重複計算。唯一序號、登錄簿與註銷紀錄就是為了擋住它。"],
          ].map(([t, q, d]) => (
            <div key={t} className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
              <h3 className="text-sm font-semibold text-ink-50">{t}</h3>
              <p className="mt-1 text-sm leading-6 text-ink-200">{q}</p>
              <p className="mt-2 text-sm leading-6 text-ink-300">{d}</p>
            </div>
          ))}
        </div>
        <p>
          這四關每個轄區都有，只是寫在不同的法律裡、由不同的機關管。本站納入的轄區與它們的法源：
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink-300">
              <tr className="border-b border-ink-500">
                <th className="py-2 pr-3 font-medium">轄區</th>
                <th className="py-2 pr-3 font-medium">機制</th>
                <th className="py-2 font-medium">法源與主管機關</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-500">
              {[
                ["🇯🇵 日本", "J-Credit", "政府制度（2013 年整合國內信用制度與 J-VER）；經濟產業省、環境省、農林水產省三省共管"],
                ["🇰🇷 韓國", "KOC", "溫室氣體排放權分配及交易法（2012）第 29、30 條；環境部溫室氣體綜合資訊中心（GIR）"],
                ["🇹🇭 泰國", "T-VER", "TGO（溫室氣體管理組織）之 T-VER 規章與公告；分 Standard 與 Premium 兩軌"],
                ["🇮🇩 印尼", "SPE-GRK", "碳經濟價值（NEK）總統令 Perpres 110/2025（取代 98/2021）；環境部與 OJK"],
                ["🇦🇺 澳洲", "ACCU", "Carbon Credits (Carbon Farming Initiative) Act 2011；Clean Energy Regulator"],
                ["🇹🇼 臺灣", "TCER", "氣候變遷因應法（2023）第 25 條專案、第 22 條查驗機構、第 26 條用途、第 27 條移轉；環境部"],
              ].map(([c, sc, law]) => (
                <tr key={c} className="text-ink-200">
                  <td className="py-2 pr-3 whitespace-nowrap text-ink-50">{c}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{sc}</td>
                  <td className="py-2 leading-6 text-ink-300">{law}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-ink-300">
          上面那家扣件廠是<b>臺灣的例子</b>，用它是因為細節具體、好懂；換成北海道的鑄造廠或昆士蘭的造林地，
          四關的問法一模一樣，只有方法學代碼與主管機關會換。
        </p>
        <h3 className="pt-2 font-display text-base font-semibold text-ink-50">那，誰會來買？</h3>
        <p>
          碳權不是慈善捐款，買方多半有很現實的理由。各國的制度名稱不同，需求的形狀其實只有三種：
        </p>
        {/*
          碳費費率與徵收對象會隨環境部公告調整（費率審議會定期檢討）。
          這幾個數字是對外說明的一部分，改版前請回環境部碳費專區確認一次：
          https://www.cca.gov.tw/affairs/carbon-fee-fund/2301.html
        */}
        <div className="space-y-3">
          {[
            ["有法定履約義務的排放源", "碳價制度下的受管制業者：韓國 K-ETS 的納管事業可用 KOC 抵換應繳配額（上限 10%）；新加坡的碳稅對象可用國際碳權抵 5% 應稅排放；臺灣碳費對象可用減量額度扣除收費排放量（國內 10%、國外 5%）；中國全國碳市場的重點排放單位可用 CCER 抵銷 5%。上限都不高——制度設計就是要企業先自己減，額度是補最後一段。"],
            ["要做開發案抵換的專案", "新設或擴建須就新增排放量取得額度抵換一定比率，通常在環境影響評估階段處理。這類買方的時間點很集中、而且非買不可，各國多半只認本國核發的額度。"],
            ["要對外宣告的企業或活動", "ESG 報告、產品碳中和標示、一場演唱會或馬拉松要宣稱碳中和，都得買額度並且「註銷」。沒註銷等於沒用掉——額度還在你手上，就代表你隨時可以賣給別人，這種宣告不成立。這一類最不受國別限制，但相對地，宣告的可信度全靠證據鏈。"],
          ].map(([t, d]) => (
            <div key={t} className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
              <h4 className="text-sm font-semibold text-ink-50">{t}</h4>
              <p className="mt-1 text-sm leading-6 text-ink-300">{d}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── 巴黎協定 ───────────────────────────────────────────────── */}
      <Section id="paris" eyebrow="國際框架" title="巴黎協定第六條：跨境的那一噸，帳怎麼記">
        <p>
          1997 年的<b>京都議定書</b>是「上面派功課」：由公約分配已開發國家各自的減量義務。
          2015 年在巴黎通過的<b>巴黎協定</b>改成「自己交作業、定期加碼」——每個國家自行提出
          <b>國家自定貢獻（NDC）</b>，每五年檢討一次，而且只能更嚴、不能放鬆。
          共同目標是把全球升溫控制在遠低於 2°C，並努力守在 1.5°C 以內。
        </p>
        <p>
          本站納入的轄區裡，多數是締約方，有些不是——例如臺灣不是聯合國會員，也不是巴黎協定締約方，
          但 2023 年的氣候變遷因應法照樣把 2050 淨零寫進國內法。<b>締約與否不影響本站的交易</b>：
          本站交易的是各國<b>國內制度</b>核發的額度，不是第六條下的國際移轉單位。
          第六條在這裡的意義有兩層——制度藍本，以及跨境使用時避不開的那個問題。
        </p>
        <p>
          協定的<b>第六條</b>處理的是：國與國之間可以怎麼合作減量，以及減量成果移轉之後要怎麼記帳才不會被算兩次。三條路徑：
        </p>
        <div className="space-y-3">
          {[
            [
              "第 6.2 條",
              "合作方法（Cooperative Approaches）",
              "兩國直接談。例如瑞士出資在泰國曼谷汰換一批電動巴士，減下來的量記在瑞士的 NDC 上；泰國則必須做「相應調整」，把移轉出去的量加回自己的排放帳。沒有這一步，同一公噸就會被兩個國家各記一次。這是目前少數已經實際完成移轉的案例之一。",
            ],
            [
              "第 6.4 條",
              "巴黎協定額度機制（PACM）",
              "聯合國自己開的集中式機制，由第 6.4 條監督機構管理，依 Decision 3/CMA.3 建立，接手清潔發展機制（CDM）的角色，並處理既有 CDM 專案的轉換。專案一樣要註冊、監測、查證、核發，流程與國內制度高度相似，差別在於發證的是聯合國層級。",
            ],
            [
              "第 6.8 條",
              "非市場方法",
              "不涉及額度買賣的合作：資金支援、技術移轉、能力建構。有些減量本來就不適合被切成一噸一噸拿去交易，這條路徑處理的就是那一塊。",
            ],
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
          <b>本平台與第六條的關係，說清楚：</b>本站掛的每一批額度都是某個國家<b>國內制度</b>的產物
          （J-Credit、KOC、T-VER、SPE-GRK、ACCU、TCER），既不是第 6.2 條下的 ITMO，也不是第 6.4 條核發的 A6.4ER。
          <b>本站不代表任何一批額度已取得地主國的授權或相應調整</b>，除非該批額度另有載明。
          這件事為什麼重要：沒有相應調整，那一公噸仍然記在地主國自己的 NDC 裡——買方若又據以主張碳中和，
          同一公噸就被主張了兩次。UNFCCC 在 6.4 機制下用兩類單位處理這個張力：已授權可跨境使用的 AER，
          以及未授權、只計入地主國 NDC 的 MCU。
          第六條的另一層意義是<b>制度藍本</b>：專案註冊 → 監測 → 查證 → 唯一序號 → 登錄簿 → 註銷，
          這一整套防止重複計算的作法是二十多年累積下來的共識，本平台的鏈上設計就是照著它做的。
          將來要與國際機制銜接，缺的是國家授權那類政治安排，不是資料結構。
        </Notice>
      </Section>

      {/* ── ISO 14064 ─────────────────────────────────────────────── */}
      <Section id="iso" eyebrow="量化與查驗標準" title="ISO 14064：誰來當那把磅秤">
        <p>
          「這家扣件廠一年少排 1,000 公噸」這句話要有人信，得先回答兩件事：<b>怎麼量</b>，以及<b>誰來查</b>。
          ISO 14064 就是這兩件事的國際標準，分成三部分，可以當成三種不同用途的磅秤：
        </p>
        <div className="overflow-hidden rounded-[--radius-card] border border-ink-500">
          <table className="w-full text-sm">
            <thead className="bg-ink-600 text-left text-xs uppercase tracking-wider text-ink-300">
              <tr><th className="px-4 py-2 font-medium">標準</th><th className="px-4 py-2 font-medium">量什麼</th><th className="px-4 py-2 font-medium">內容</th></tr>
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
          講白話，前面那四關——基線、外加性、洩漏、重複計算——就是這份標準要求你在文件裡交代清楚的東西。
        </p>
        <p>
          <b>ISO 14064-3:2019</b> 規範的是查核，而且是<b>兩個不同時間點</b>的查核。這兩個詞常被混用，其實差很多：
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
            <h3 className="text-sm font-semibold text-ink-50">確證 Validation ＝ 開工前審圖</h3>
            <p className="mt-1 text-sm leading-6 text-ink-300">
              專案還沒開始做。查驗機構先審計畫書：基線合不合理、外加性站不站得住、監測計畫做不做得到。
              審不過就退回修改，改到過為止。
            </p>
          </div>
          <div className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
            <h3 className="text-sm font-semibold text-ink-50">查證 Verification ＝ 完工後驗收</h3>
            <p className="mt-1 text-sm leading-6 text-ink-300">
              監測期跑完了。查驗機構核對實際數據、查看現場，出具查證聲明：這段期間確實減了這麼多。
              數字對不上、紀錄有缺口，就砍量或不給過。
            </p>
          </div>
        </div>
        <p>
          所以同一個專案至少會被查兩次。查驗機構的獨立性與許可資格是整套制度的信任根基——
          這個簽名如果可以買，上面所有的數字都不用看了。各國對查驗機構的認證與許可要求不同，但這一層在哪裡都存在。
          本平台把它做成鏈上的硬規則：
          核發額度必須帶著查驗機構的簽章，平台自己簽不出來。
        </p>
        <p className="text-xs leading-6 text-ink-300">
          ISO 14060 系列是「溫室氣體制度中立」的：它提供方法，但若另有適用的溫室氣體管理制度，該制度的要求會疊加在標準之上。
          本站納入的每一個轄區都是這種疊加：方法與查驗框架來自 ISO 14064-2／-3，
          法律效力與核准程序來自各該國的制度（例如臺灣的氣候變遷因應法及其子法、日本的 J-Credit 制度規程）。
        </p>
      </Section>

      {/* ── 生命週期 ──────────────────────────────────────────────── */}
      <Section id="lifecycle" eyebrow="從減量到註銷" title="一個專案的九個階段，本平台在最後兩段">
        <p>
          接著把扣件廠那 1,000 公噸從頭走一遍。前七段發生在平台之外，由開發者、查驗機構與主管機關完成；
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
          這九段在鏈上長成這樣：專案與每一批額度寫進<b>登錄層</b>（合約不可升級，確保歷史不會事後被改）；
          查驗機構的核發是一筆帶著簽章的交易，序號唯一、不可重複；<b>交易</b>走企業掛單市場；
          <b>註銷</b>會直接銷毀額度，並鑄造一張不可移轉的憑證，上面記著受益人、用途與數量。
          憑證 PDF 的 SHA-256 也寫在鏈上，任何人下載後自行重算就能比對，不必相信平台。
        </p>
      </Section>

      {/* ── 在地減碳與企業社會責任 ─────────────────────────────────── */}
      <Section id="local" eyebrow="為什麼優先買在地" title="同樣一公噸，買在地的那一公噸不一樣">
        <p>
          先定義「在地」：指的是<b>你要申報的那個轄區</b>。首爾的公司，在地是韓國；曼谷的工廠，在地是泰國。
          一公噸二氧化碳在大氣裡不分國籍，「減在哪裡都一樣」在物理上站得住腳；
          但你買的不只是那一公噸，還有<b>能不能拿來申報</b>、<b>減量發生在誰的土地上</b>，
          以及<b>這筆錢流到哪裡</b>。這三件事，本地與境外差很多。
        </p>
        <p>
          三個理由，跟哪一國無關：
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {[
            ["① 申報上用得多", "幾乎每個碳價制度都給本地額度較高的上限，境外額度則被壓低、加上認可程序，或直接排除某些用途。同樣的預算，本地額度能抵掉的量通常多出一截。"],
            ["② 開發案抵換只認本地", "環評與開發許可階段的增量抵換，主管機關要的是本地的環境效益，境外額度一噸都用不上。真的要擴廠時，手上的境外額度幫不了忙。"],
            ["③ 共效益落在自己身上", "本地的燃料轉換、廢熱回收、造林專案，減碳的同時也減硫氧化物與粒狀污染物，受益的是同一批員工與鄰里；那筆錢也留在自己的供應鏈裡。"],
          ].map(([t, d]) => (
            <div key={t} className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
              <h3 className="text-sm font-semibold text-ink-50">{t}</h3>
              <p className="mt-1 text-sm leading-6 text-ink-300">{d}</p>
            </div>
          ))}
        </div>
        <p>
          具體差多少要看你的申報地。以<b>在臺灣申報碳費</b>為例（其他轄區的數字見上一節的對照表）：
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-[--radius-card] border border-tide/40 bg-tide/5 p-4">
            <h3 className="text-sm font-semibold text-ink-50">本地額度（臺灣 TCER）</h3>
            <ul className="mt-2 space-y-1.5 text-sm leading-6 text-ink-200">
              <li>· 扣除碳費排放量，上限<b>收費排放量的 10%</b></li>
              <li>· 自願減量專案額度的扣除比率是 <b>1.2</b>——買 1 公噸抵 1.2 公噸</li>
              <li>· 可用於<b>環評增量抵換</b>與環評承諾事項</li>
            </ul>
          </div>
          <div className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
            <h3 className="text-sm font-semibold text-ink-50">境外額度（在臺灣申報時）</h3>
            <ul className="mt-2 space-y-1.5 text-sm leading-6 text-ink-200">
              <li>· 扣除碳費上限只有<b>收費排放量的 5%</b>，而且<b>沒有</b>加成比率</li>
              <li>· 須先經<b>中央主管機關認可</b>，認可與否不在本站手上</li>
              <li>· <b>高碳洩漏風險事業完全不得使用</b>（鋼鐵、水泥等）</li>
              <li>· <b>不能</b>用於環評增量抵換——本站在鏈上就擋下這個選項</li>
            </ul>
          </div>
        </div>
        <p className="text-xs text-ink-300">
          依據：氣候變遷因應法第 26、27 條；碳費收費辦法第 9、10 條；溫室氣體減量額度交易、拍賣及移轉管理辦法第 4 條。
          在其他轄區申報，適用的是該轄區與核發國的法規。
        </p>

        <Example title="便宜六成的那一批，可能一噸都用不上">
          <p>
            一家在臺灣申報碳費的螺絲廠，今年要處理 1,000 公噸的缺口。兩個選擇：
            每噸 320 元買泰國稻殼生質鍋爐的額度，或每噸 800 元買隔壁鄉鎮那座熱處理爐燃料轉換專案的額度。
            單看價格，泰國的便宜六成。
          </p>
          <p>
            把三件事算進去，答案會翻過來：本地額度的扣除比率 1.2、上限 10%，境外額度沒有加成、上限 5%，
            <b>能扣的量差了一倍以上</b>；明年要擴廠、需要環評增量抵換的話，<b>境外額度一噸都不能用</b>；
            而那座燃料轉換專案就在同一條產業聚落裡，重油改天然氣不只少了二氧化碳，
            <b>也少了硫氧化物與粒狀污染物</b>，受益的是同一批員工與他們的家人。
          </p>
          <p>
            把場景換成首爾——韓國的納管事業用 KOC 抵換應繳配額、上限 10%，未結轉的抵換單位
            <b>在發行年度結束後 8 個月就失效</b>——算式不同，結論的形狀一樣：先確認用途與時效，再比價格。
          </p>
          <p className="text-ink-300">
            這不是說境外額度沒有用。集團在東南亞有廠、要處理當地營運的排放，
            或者自願性碳中和宣告需要量體，境外額度都是合理選擇。
            重點是<b>先看用途，再看價格</b>——反過來的話，買到的很可能是一批用不上的便宜額度。
          </p>
        </Example>

        <h3 className="pt-2 font-display text-base font-semibold text-ink-50">企業社會責任：可以被查證的那一種</h3>
        <p>
          ESG 報告裡最難寫的一段，往往不是「我們減了多少」，而是「憑什麼相信」。
          在本站買進與註銷的每一筆，都留下三樣東西可以貼進報告：
          <b>註銷憑證</b>（載明受益人、用途、數量、核發國）、
          <b>公開的鏈上紀錄</b>（任何人都能自己重算），以及
          <b>官方註銷編號與可對外宣告日</b>（依核發國規定；例如臺灣是主管機關於註銷次日起五個工作日內公開，公開後才可以對外宣告）。
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ["在地供應鏈", "買自己所在地的減量專案，等於把錢投進自己供應鏈的鍋爐與製程改善。下一輪要查供應商碳含量時，受益的還是自己。"],
            ["空污共效益", "本地的燃料轉換、廢熱回收專案，減碳的同時也減硫氧化物與粒狀物。這部分寫進 CSR 報告是實話，而且查得到。"],
            ["對外宣告有依據", "憑證上有核發國、官方註銷編號與可宣告日；沒有完成官方程序之前，本站會照實標示「辦理中」，不讓你提早宣告。各國的公開時程不同，憑證上以該國規定為準。"],
          ].map(([t, d]) => (
            <div key={t} className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
              <h4 className="text-sm font-semibold text-ink-50">{t}</h4>
              <p className="mt-1 text-sm leading-6 text-ink-300">{d}</p>
            </div>
          ))}
        </div>
        <p className="text-ink-300">
          反過來說，有幾句話不要寫進報告：買了但還沒註銷的額度<b>不能</b>宣稱已減量；
          官方尚未公開之前<b>不能</b>對外宣告；自然人持有的額度<b>不能</b>用於任何法定申報。
          這些限制本站都會在介面上直接擋下或標示——擋下來比事後更正便宜太多。
        </p>
      </Section>

      {/* ── 亞太各國額度 ─────────────────────────────────────────── */}
      <Section id="markets" eyebrow="納入哪些國家" title="亞太各國的減量額度，同一本掛單簿">
        <p>
          本站納入的是<b>已經有國家級自願減量法規與官方登錄簿</b>的轄區——不是任何一個自稱碳權的東西都收。
          判準有三個：有法源、有政府營運（或政府指定）的登錄簿、有可查證的核發紀錄。
          交易所平台本身（例如某些交易所的自願碳市場）不算登錄簿。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink-300">
              <tr className="border-b border-ink-500">
                <th className="py-2 pr-3 font-medium">轄區</th>
                <th className="py-2 pr-3 font-medium">機制</th>
                <th className="py-2 pr-3 font-medium">主管機關 / 登錄簿</th>
                <th className="py-2 font-medium">本站狀態</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-500">
              {[
                ["🇹🇼 臺灣", "TCER", "環境部／溫室氣體減量額度管理系統", "開放交易"],
                ["🇯🇵 日本", "J-Credit", "經產・環境・農水三省／Ｊ－クレジット登録簿", "開放交易"],
                ["🇰🇷 韓國", "KOC", "環境部 GIR／抵換登錄系統", "開放交易"],
                ["🇹🇭 泰國", "T-VER", "TGO／T-VER Registry", "開放交易"],
                ["🇮🇩 印尼", "SPE-GRK", "環境部／SRN PPI（與 IDXCarbon 連線）", "開放交易"],
                ["🇦🇺 澳洲", "ACCU", "Clean Energy Regulator／ANREU", "開放交易"],
                ["🇨🇳 中國", "CCER", "生態環境部／全國自願減排註冊登記系統", "暫不開放：跨境使用規定尚未訂定"],
                ["🇮🇳 印度", "CCC", "Ministry of Power・BEE／Indian Carbon Market", "暫不開放：國際移轉須中央核准"],
                ["🇸🇬 新加坡", "ICC（買方框架）", "NCCS・NEA（無自建登錄簿）", "不核發：碳稅抵換上限 5%，須第 6 條相應調整"],
              ].map(([c, sc, reg, st]) => (
                <tr key={c} className="text-ink-200">
                  <td className="py-2 pr-3 whitespace-nowrap text-ink-50">{c}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{sc}</td>
                  <td className="py-2 pr-3">{reg}</td>
                  <td className={`py-2 ${st.startsWith("暫不") || st.startsWith("不核發") ? "text-warn" : "text-ink-200"}`}>{st}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          「暫不開放」不是技術限制，是那些國家還沒開門：中國的《溫室氣體自願減排交易管理辦法》第 29 條
          明定跨境交易與使用的規定「另行制定」，印度 CCTS 的國際移轉須經中央政府核准。
          規定一旦公布，本站可以由主權角色在鏈上開啟該轄區，不必改合約。
        </p>
        <p>
          反過來也一樣：本站<b>只開放各該核發國法規已經容許跨境交易或使用的轄區</b>，
          並且會依各國法規、政策或登錄簿規則的變動，隨時停止某一轄區的上架與新掛單並公告。
          <b>已經持有的額度不受影響</b>——仍然可以持有、在本站出售，或依該國登錄簿規則辦理註銷，
          但流動性與可用途徑可能因此改變。
        </p>
        <p className="text-ink-300">
          還有一件跨境交易繞不開的事：<b>相應調整</b>。依巴黎協定第 6.2 條，
          地主國授權減量成果作國際用途時，必須在自己的排放清冊上作對應調整，否則同一公噸會被算兩次。
          新加坡的碳稅抵換就強制要求這一點，並且只收已簽實施協定的夥伴國額度。
          各國對境外額度的認可條件寬嚴不一，有些（如臺灣）甚至尚未公告細節，所以本站的作法一律是：
          <b>照實標示核發國與機制，不對任何一國的認可結果做承諾</b>。
        </p>
      </Section>

      {/* ── 額度用途與邊界 ─────────────────────────────────────────── */}
      <Section id="use" eyebrow="能用在哪、不能用在哪" title="買到額度之後，實際能拿來做什麼">
        <p>
          先問兩個問題，順序不能顛倒：<b>這批額度是誰核發的</b>，以及<b>你要在哪裡申報</b>。
          兩者相同（本地額度、本地申報）時限制最少；兩者不同時，多數轄區都會加上認可程序、
          數量上限，或直接排除某些用途。下表是幾個轄區對<b>境外額度</b>的處理，數字都來自各國現行規定：
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink-300">
              <tr className="border-b border-ink-500">
                <th className="py-2 pr-3 font-medium">申報地</th>
                <th className="py-2 pr-3 font-medium">本地額度</th>
                <th className="py-2 pr-3 font-medium">境外額度</th>
                <th className="py-2 font-medium">附帶條件</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-500">
              {[
                ["🇹🇼 臺灣（碳費）", "上限 10%，自願減量專案額度扣除比率 1.2", "上限 5%，無加成", "須經中央主管機關認可；高碳洩漏風險事業不得使用；不得用於環評增量抵換"],
                ["🇰🇷 韓國（K-ETS）", "KOC 抵換上限為應繳配額 10%", "依主管機關規定", "未結轉之抵換單位於發行年度結束後 8 個月失效"],
                ["🇸🇬 新加坡（碳稅）", "無本國核發機制", "上限 5% 應稅排放", "須符合巴黎協定第 6 條並由地主國作相應調整；僅限已簽實施協定之夥伴國"],
                ["🇨🇳 中國（全國碳市場）", "CCER 抵銷上限 5%", "尚未開放", "跨境交易與使用之規定「另行制定」（部令第 31 號第 29 條）"],
              ].map(([who, dom, foreign, note]) => (
                <tr key={who} className="text-ink-200">
                  <td className="py-2 pr-3 whitespace-nowrap text-ink-50">{who}</td>
                  <td className="py-2 pr-3">{dom}</td>
                  <td className="py-2 pr-3">{foreign}</td>
                  <td className="py-2 leading-6 text-ink-300">{note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-300">
          這張表是幫你抓方向用的，不是法律意見；實際適用以各該主管機關的現行規定與公告為準。
          本站照實標示核發國與機制，不代為判斷你的申報資格。
        </p>
        <p>
          額度的法定用途本身，各國的分類很接近，大致是這三種：
        </p>
        <div className="space-y-3">
          {[
            ["抵減碳價（碳費、碳稅或 ETS 履約）", "受管制的排放源用額度扣抵應繳金額或應繳配額。這是額度最主要的需求來源，也是價格的天花板——額度貴過碳價，企業就寧可直接繳錢。所以行情圖上那條水平參考線畫的是碳價。"],
            ["開發案的增量抵換", "新設或擴建就新增排放量取得額度抵換一定比率，通常在環境影響評估階段處理。這一類幾乎都限本地額度：主管機關要的是本地的環境效益。"],
            ["自願性宣告", "ESG 報告、產品碳中和、活動碳中和。沒有法定上限，但必須完成註銷——沒註銷等於沒用掉，額度還在你手上，代表你隨時可以賣掉，這種宣告不成立。"],
          ].map(([t, d]) => (
            <div key={t} className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
              <h3 className="text-sm font-semibold text-ink-50">{t}</h3>
              <p className="mt-1 text-sm leading-6 text-ink-300">{d}</p>
            </div>
          ))}
        </div>
        <Example title="出口到歐盟的製造商：CBAM 不吃碳權">
          <p>
            回到前面那家扣件廠——設在哪一國都一樣，下面這段邏輯對任何出口到歐盟的製造商都成立。它的螺絲有一半出口到歐盟。歐盟碳邊境調整機制（CBAM）自 2026 年 1 月 1 日起進入正式期：
            歐盟的進口商必須申報貨品的碳含量，並購買、繳銷 CBAM 憑證，憑證價格連動歐盟排放交易體系（EU ETS）的配額拍賣價。
            涵蓋品項包括水泥、鋼鐵、鋁、肥料、電力與氫——螺絲屬於鋼鐵製品，在範圍內。
          </p>
          <p>
            關鍵在於：CBAM 承認的是<b>在生產國實際已經支付的碳價</b>，
            <b>而不是</b>自願減量額度。所以「買碳權就能過 CBAM」是錯的。
          </p>
          <p>
            而且這家廠還有一個更尷尬的處境：它整廠年排放約三千公噸，<b>沒有達到所在國碳價制度的納管門檻</b>
            （以臺灣為例是 2.5 萬公噸），根本沒繳碳費——在 CBAM 那一端，也就沒有「已支付的碳價」可以扣。
            它做減量專案的理由不是抵自己的碳費，而是<b>把減下來的量賣掉</b>，
            以及向歐盟客戶交代產品的碳含量確實變低了：<b>碳含量降低會直接減少進口商要買的 CBAM 憑證數量</b>，
            這才是出口商在 CBAM 下真正的施力點。
          </p>
          <p className="text-ink-300">
            另一層反直覺的效果，對有繳碳價的大廠才成立：用額度扣掉的那部分，是「沒有實際支付的碳價」，
            在 CBAM 那一端能主張的扣抵也會跟著變少。兩邊要一起算，不能只看單邊。
          </p>
        </Example>
        <p className="text-sm">
          基於上述理由，本平台不把「CBAM 扣抵」列為額度用途。若規則變動，會依主管機關與歐盟公告更新。
        </p>
        <h3 className="pt-2 font-display text-base font-semibold text-ink-50">那，我買到的到底是什麼？</h3>
        <p>
          你買到的是<b>一批已經發生、而且被查驗過的減量</b>，以及在需要的時候把它<b>登記成用掉</b>的權利。
          聽起來拗口，但對你的實際差別只有一件事：<b>買賣的時候誰都不用跑流程，要用的時候我們幫你辦。</b>
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ["買的時候", "點一下就成交，價金與額度同時交割。不必跑環境部、不必等公文。"],
            ["放著的時候", "隨時看得到，也隨時可以再賣掉。轉幾手都不影響官方登錄簿，沒有保管費。"],
            ["要用的時候", "按「註銷」，我們替你聯繫專案方辦官方過戶，再由你自己送出註銷申請，完成後憑證上會出現官方註銷編號。"],
          ].map(([t, d]) => (
            <div key={t} className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
              <h4 className="text-sm font-semibold text-ink-50">{t}</h4>
              <p className="mt-1 text-sm leading-6 text-ink-300">{d}</p>
            </div>
          ))}
        </div>
        <p>
          額度從核發到用掉，<b>全程存放在核發國政府的官方登錄簿帳戶裡</b>——國內額度在專案方於環境部
          「溫室氣體減量額度管理系統」開立的額度帳戶，國外額度在本站於該國登錄簿開立的託管帳戶。
          本平台自己的錢包裡沒有任何額度，鏈上跑的是對那些託管額度的請求權；
          兩邊對不對得起來，每月 5 日在<Link className="text-tide underline" href="/custody">託管揭露</Link>公開，
          由查核機構簽署後上鏈。
          國內額度還有一層：臺灣的法規規定<b>每一單位額度在官方登錄簿只能過戶一次</b>——如果每次買賣都去辦一次，第二手就沒得賣了。
          所以那唯一一次過戶留到最後：<b>有人真的要用掉的時候，才從專案方直接過戶給他</b>，中間轉了幾手都不算。
          國外額度沒有這一段，它始終留在本站於核發國登錄簿的託管帳戶內，鏈上易主不觸動該帳戶；
          要用掉的時候，依<b>該核發國登錄簿的規則</b>辦理註銷。
        </p>
        <Notice kind="info">
          <b>如果你是個人，有一件事要先知道：</b>環境部的額度帳戶只開給公司、行號、工廠等「事業」，
          個人開不了帳戶，因此<b>個人無法在官方登錄簿註銷額度</b>。你可以買、可以持有、也可以隨時賣出，
          但不能拿來做碳費扣抵、環評抵換這類申報，也不能據以宣稱碳中和。
          要實際用掉，得由有統一編號的事業來買。
        </Notice>
        <p className="text-ink-300">
          萬一賣方到時候不配合過戶怎麼辦？契約寫了一條：平台會在十四日內<b>調度等值的額度</b>給你
          （同年份或更新年份、同用途、同數量，不加價），拿不到就全額退款再補償。
          同時賣方會失去上架資格、被追繳先前減免的代辦費。
          另外，每一筆核發、上架、移轉、註銷都會即時出現在<Link className="text-tide underline" href="/registry">公告欄</Link>，
          包括別人的，你可以自己核對；完整的做法與時程寫在
          <Link className="text-tide underline" href="/agreements?id=service-flow">服務流程說明書</Link>裡。
        </p>
        <p className="text-xs leading-6 text-ink-300">
          本站目前為 Phase 0 展示版本：身分驗證、查驗機構簽章與結算幣皆為模擬，額度不具法律效力，不得作為任何申報依據。
          正式營運的前提是主管機關認可、查驗機構以自己的金鑰簽章，以及金融機構提供的結算工具。
        </p>
      </Section>
    </div>
  );
}
