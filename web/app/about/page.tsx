"use client";
import { Notice } from "@/components/ui";
import { MarketPanel } from "@/components/MarketPanel";
import { MarketOverview } from "@/components/MarketOverview";
import Link from "next/link";
import { ChapterNav } from "@/components/ChapterNav";

/// 認識碳權。首頁是市場現況，這一頁回答「這個市場在交易什麼」。
///
/// 說明文字刻意寫得像講給人聽，而不是抄法條：
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

/// 減碳專案的五個大類。這是**人在想事情時**的分類——「我們是做再生能源的」——
/// 而各國登錄簿的類別表長得不一樣（臺灣是 B-1 到 B-14 的產業別）。
/// 兩套分類對不齊，正是申請時第一個會撞到的東西，所以這張表兩邊都列。
///
/// `catch` 欄不是湊字數：每一類真正會被退件的地方都不同，而那通常不是技術問題，
/// 是外加性、基線或監測沒設計好。寫在這裡，讓人在動筆寫計畫書之前就知道要準備什麼。
const METHOD_FAMILIES = [
  {
    key: "sink",
    title: "自然碳匯與碳移除",
    lead: "把已經排到大氣裡的碳抓回來存住——靠植物、土壤、海岸濕地，或打進地層。",
    examples: "造林與再造林、森林經營改善、土壤有機碳、紅樹林與海草的藍碳復育、CCS 地質封存",
    tw: "B-14 造林與植林",
    au: "Plantation forestry、Reforestation by environmental or mallee plantings FullCAM 2024、Improved forest management in multiple-use public native forests、Savanna fire management、Tidal restoration of blue carbon ecosystems、Carbon capture and storage",
    catch:
      "**永久性**。其他四類減的是「沒排出去的碳」，這一類存的是「已經抓回來的碳」——" +
      "而抓回來的碳會因為火災、病蟲害、砍伐或土地變更再跑出去。所以這一類的方法" +
      "幾乎都額外要求緩衝額度、長期監測義務與逆轉時的補回機制，計入期也最長" +
      "（臺灣：移除類型固定型 30 年，是減少排放類型的三倍）。" +
      "另一個常見的坑是**洩漏**：在這塊地停止砍伐，砍伐移到隔壁，淨減量是零。",
  },
  {
    key: "industry",
    title: "工業與高溫製程減碳",
    lead: "鍋爐、加熱爐、熔煉、窯爐——換燃料、把廢熱撿回來用，或直接改製程。",
    examples: "燃料轉換（重油→天然氣）、廢熱回收、高效率設備汰換、製程改善、含氟氣體與 N₂O 削減",
    tw: "B-4 製造工業、B-5 化學製造業、B-9 金屬製造業、B-3 能源需求業、B-11 來自鹵化物及氟硫化物製造和使用之逸散",
    au: "Industrial and commercial emissions reduction、Industrial equipment upgrade",
    catch:
      "**財務外加性與普遍性**。節能設備常常本來就會回本——一旦「不做也划算」，" +
      "外加性就站不住。臺灣的辦法把外加性拆成法規、財務、普遍性、障礙四項分析（第 2 條第 6 款），" +
      "這一類最常靠後兩項過關：技術在國內還不普遍，或存在資金、技術、資訊上的障礙。" +
      "第二個坑是**基線要綁產量**：少燒的燃料如果是因為減產，那不是減量。監測計畫必須同時記錄產量。",
  },
  {
    key: "renewable",
    title: "再生能源與能源結構轉型",
    lead: "用不排碳的電或熱，把原本排碳的那一份換掉。",
    examples: "太陽光電、風力、小水力、地熱、生質能鍋爐、沼氣發電、自用型再生能源熱能",
    tw: "B-1 能源工業（含再生能源/非再生能源）、B-2 能源輸配業",
    au: "（ACCU 機制目前不以再生能源發電為主要方法類別，相關減量多由電力市場機制處理）",
    catch:
      "**重複計算**，而且有兩個層次。第一，同一度綠電如果已經以再生能源憑證賣出環境效益，" +
      "再拿來主張碳權就是同一件事賣兩次；臺灣的辦法第 17 條明文要求監測報告要「避免重複計算」。" +
      "第二，基線用的是**公告的電力排碳係數**（同條），係數逐年下修——電網自己變乾淨時，" +
      "同一座電廠能主張的減量會逐年變少，這要在財務模型裡先算進去。",
  },
  {
    key: "agriculture",
    title: "農業與甲烷抑制",
    lead: "牛打嗝、糞尿堆置、水稻田淹水、氮肥——這些都會放出甲烷或氧化亞氮。",
    examples: "畜牧糞尿厭氧消化與沼氣回收、飼料添加劑降低腸道甲烷、水稻田間歇灌溉（AWD）、氮肥管理",
    tw: "臺灣的類別表**沒有獨立的農業類**（B-1 到 B-14 裡最接近的是 B-13 廢棄物處理及棄置）",
    au: "Animal effluent management、Estimating soil organic carbon sequestration using measurement and models",
    catch:
      "**量測不確定性與 GWP 版本**。甲烷不像燃料有油表可讀，排放量多半靠模型加係數推估，" +
      "所以這一類的方法通常要求較高的保守性（估低不估高）與較密的抽樣。" +
      "另外甲烷要換算成 CO₂e，用哪一版 GWP 由各機制規定——換一版，同一個專案的額度數量就不同，" +
      "跨轄區比較時要先確認雙方用的是不是同一版。",
  },
  {
    key: "waste",
    title: "廢棄物管理與資源循環",
    lead: "別讓有機物悶在土裡爛成甲烷，或讓材料少走一次高耗能的製程。",
    examples: "掩埋場沼氣收集與發電、廚餘厭氧消化、堆肥、廢水處理的甲烷回收、材料回收與再生粒料",
    tw: "B-13 廢棄物處理及棄置",
    au: "Reducing methane emissions from landfill gas method 2025",
    catch:
      "**法規外加性**。這一類最常在第一關就被否決：如果法規已經強制要求收集或處理，" +
      "那麼做這件事是義務，不是額外的減量——臺灣的定義寫得很直白，外加性要確認其" +
      "「非法規要求」（第 2 條第 6 款）。所以同一座掩埋場，在法規還沒強制的年代可以申請，" +
      "法規上路之後就不行了。第二個坑是**基線情境要誠實**：如果沒有這個專案，那些甲烷" +
      "真的會全部逸散嗎？多數方法會要求扣掉本來就會被火炬燒掉的部分。",
  },
] as const;

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

/// 把資料裡的 `**粗體**` 轉成 <b>。
///
/// 為什麼需要它：METHOD_FAMILIES 那幾段是**資料**不是 JSX，裡面又真的需要強調
/// （「最容易卡住的地方」那一句的主詞）。少了這個轉換，畫面上就會出現裸露的星號——
/// 而且只會出現在後來才加上強調的那幾個欄位，很容易漏看。所以每一個會顯示
/// 這份資料的地方都走這裡，不要各自處理。
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*(.+?)\*\*/).map((seg, i) =>
        i % 2 ? <b key={i} className="text-ink-50">{seg}</b> : <span key={i}>{seg}</span>,
      )}
    </>
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
export default function About() {
  return (
    <div className="space-y-14">
      {/* ── 開場：這一頁要回答什麼 ─────────────────────────────────── */}
      <header className="space-y-4">
        <p className="text-xs font-medium uppercase tracking-wider text-tide">認識碳權</p>
        <h1 className="font-display text-3xl font-bold tracking-tight text-ink-50">
          一公噸二氧化碳，怎麼變成可以買賣的東西
        </h1>
        <p className="max-w-3xl text-sm leading-7 text-ink-200">
          一家工廠少排了一公噸二氧化碳，怎麼證明？證明完了之後，這一公噸要怎麼變成別人可以買的東西？
          買走的人用掉之後，又怎麼確定同一公噸不會被第二個人再用一次？
          這三個問題構成整套碳權制度，本平台負責其中最後兩段：<b>交易</b>，以及<b>註銷</b>。
        </p>
        <p className="max-w-3xl text-sm leading-7 text-ink-200">
          額度由查驗機構在鏈上簽章核發，每一單位都能回溯到它的專案、監測期間與那一筆簽章；
          買方註銷之後拿到一張不能轉讓的憑證，那一公噸從此退出流通。
        </p>
        <p className="max-w-3xl text-sm leading-7 text-ink-200">
          本站是<b>國際運行平台</b>，同時交易多個轄區核發的減量額度。每一批額度都標明<b>核發國</b>——
          它的法律效力、可用途徑、移轉與註銷程序，一律依<b>核發國</b>的法規與該國官方登錄簿辦理，
          不會因為在本站交易而改變。本站與用戶之間的平台服務關係，則依平台所在地（中華民國）法律——
          這是<b>兩個不同的層次</b>，不要混在一起看。
        </p>
        <p className="max-w-3xl text-sm leading-7 text-ink-200">
          一批額度能拿來做什麼，取決於兩件事：<b>誰核發的</b>，以及<b>你要在哪裡申報</b>。
          同一批日本 J-Credit，在日本、在韓國、在臺灣的待遇並不一樣；規則寫在各該國的法律裡，不在交易所的條款裡。
          所以本站在每一筆掛單、每一次下單確認、每一張憑證上都標明核發國與機制——
          判斷留給你和你的顧問，資訊由我們負責講清楚。
        </p>
      </header>

      {/* ── 行情與市場概況：圖表都在這一頁 ───────────────────────── */}
      <MarketPanel />
      <MarketOverview />

      {/*
        兩欄：左邊是常駐的章節導覽，右邊是內文。
        `minmax(0,1fr)` 而不是 `1fr`——grid 項目的最小寬度預設是內容寬度，
        內文裡有寬表格時右欄會把左欄擠掉，而且是在某些螢幕寬度下才發生。
        導覽自己是 sticky 的，所以外層不能有 overflow，否則 sticky 立刻失效。
      */}
      <div className="lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-10">
        <ChapterNav />
        <div className="space-y-14">

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

      {/* ── 怎麼把減量做成可以賣的額度 ─────────────────────────────── */}
      <Section id="mint" eyebrow="賣方指南" title="怎麼在世界各地拿到碳權，然後在這裡賣">
        <p>
          這一節是寫給<b>手上有減碳成果、想把它變成收入</b>的人。從你把鍋爐換掉，到有人在這裡向你買，
          中間隔著一個政府。整條路只有兩段：
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
            <p className="text-xs font-medium tracking-wider text-tide">第一段・在核發國</p>
            <p className="mt-1 font-display text-sm font-semibold text-ink-50">讓某一國政府發碳權給你</p>
            <p className="mt-2 text-sm leading-6 text-ink-300">
              選一套政府認可的算法 → 寫計畫 → 找查驗機構查 → 政府核發，額度進你在那個國家的官方帳戶。
              這一段本站幫不上忙，也不該幫得上忙——發碳權是政府的權力。
            </p>
          </div>
          <div className="rounded-[--radius-card] border border-tide/50 bg-tide/10 p-4">
            <p className="text-xs font-medium tracking-wider text-tide">第二段・在本站</p>
            <p className="mt-1 font-display text-sm font-semibold text-ink-50">把它掛出來賣</p>
            <p className="mt-2 text-sm leading-6 text-ink-200">
              驗證身分 → 登錄專案 → 上傳查驗報告 → 鏈上核發 → 掛單。
              額度本身<b>不會離開政府的登錄簿</b>，這裡買賣的是對它的請求權。
            </p>
          </div>
        </div>
        <p className="text-ink-300">
          最常見的誤解先講掉：<b>碳權不是你自己算出來的。</b>
          顧問公司算給你的減碳量、廠商的節能保證、自己用 Excel 推的數字，都不能拿去申請。
          你必須從那個國家<b>已經公告的算法清單</b>裡挑一套來用。這套算法叫<b>方法學</b>
          （各國正式名稱不同，臺灣叫「減量方法」）。清單裡找不到適用的，還有提案新算法的路，但那是另一條時間軸。
        </p>

        {/* ── 第一段 ───────────────────────────────────────────── */}
        <h3 className="pt-2 font-display text-base font-semibold text-ink-50">第一段：讓政府發碳權給你</h3>
        <p>
          下面以<b>臺灣</b>為例，括號裡是<b>溫室氣體自願減量專案管理辦法</b>的條號。
          其他國家的名詞不同，但骨架一樣：<b>挑算法 → 寫計畫 → 開工前被審 → 註冊 → 邊做邊記錄 → 完工後被查 → 發額度</b>。
        </p>
        <ol className="space-y-3 border-l-2 border-ink-500 pl-4">
          <li>
            <b>① 先確認你有資格</b>
            <span className="ml-1 text-xs text-ink-300">（第 3、6 條）</span>
            <p className="mt-1 text-ink-200">
              申請人必須是<b>公司、行號、工廠、機構或政府機關</b>——<b>個人不行</b>。
              可以幾家一起做，但要推一個代表、附上全體簽名<b>經過公證</b>的合約，
              而且<b>誰分幾噸要在一開始就寫進計畫書</b>，之後不能看行情再改。
            </p>
          </li>
          <li>
            <b>② 從公告的清單裡挑一套算法</b>
            <span className="ml-1 text-xs text-ink-300">（第 12 條）</span>
            <p className="mt-1 text-ink-200">
              每一套算法都寫死了它適用什麼專案、邊界畫到哪、基線怎麼設。
              你的專案必須<b>落在某一套的適用條件裡</b>；差一點點就得換一套，或換一個國家申請。
            </p>
          </li>
          <li>
            <b>③ 寫專案計畫書</b>
            <span className="ml-1 text-xs text-ink-300">（第 4 條；外加性定義見第 2 條第 6 款，小規模放寬見第 8 條）</span>
            <p className="mt-1 text-ink-200">
              計畫書要說清楚三件事：用哪一套算法、<b>不做這個專案的話會排多少</b>（基線），
              以及<b>為什麼這件事需要碳權才做得成</b>。
            </p>
            <p className="mt-1 text-ink-300">
              最後那一項叫<b>外加性</b>，是最多人卡住的地方。法規要你證明四件事的組合：
              不是法規本來就要求的、光看財務不划算、技術在國內還不普遍、或者存在資金與技術上的障礙。
              規模小的專案有放寬——小規模只要證明「不是法規要求」，另外三項擇一；更小規模的只要第一項。
            </p>
          </li>
          <li>
            <b>④ 開工前先讓查驗機構審圖</b>
            <span className="ml-1 text-xs text-ink-300">（確證，第 2、4 條）</span>
            <p className="mt-1 text-ink-200">
              查驗機構審的是<b>還沒發生的事</b>：基線合不合理、外加性站不站得住、監測計畫做不做得到。
              審過了會出一份<b>確證總結報告</b>，跟計畫書一起送去註冊。
            </p>
          </li>
          <li>
            <b>⑤ 註冊，時鐘開始跑</b>
            <span className="ml-1 text-xs text-ink-300">（第 7 條）</span>
            <p className="mt-1 text-ink-200">
              註冊之後才算數：<b>註冊之前已經做完的減碳，不能回頭認列。</b>
              註冊同時決定這個專案還能生多少年的額度（計入期）——
              種樹這類「把碳存起來」的最長，固定型 30 年；換設備這類「少排一點」的固定型 10 年。
            </p>
          </li>
          <li>
            <b>⑥ 邊做邊記錄</b>
            <span className="ml-1 text-xs text-ink-300">（第 4、17 條）</span>
            <p className="mt-1 text-ink-200">
              照計畫抄表、留紀錄，<b>同時記產量</b>——「同樣產量下少燒多少」才算減量。
              用電的部分要用政府<b>公告的電力排碳係數</b>，而且不能跟別的制度重複主張同一度電。
            </p>
            <p className="mt-1 text-ink-300">
              這一段最常出事：表計壞了又沒有補救程序，那段期間的減量多半就算不進去了。
            </p>
          </li>
          <li>
            <b>⑦ 完工後驗收</b>
            <span className="ml-1 text-xs text-ink-300">（查證，第 2、16 條）</span>
            <p className="mt-1 text-ink-200">
              這次查的是<b>已經發生的事</b>：核對數據、看現場，出一份<b>查證總結報告</b>，
              連同監測報告書一起送去申請額度。
            </p>
          </li>
          <li>
            <b>⑧ 政府核發</b>
            <span className="ml-1 text-xs text-ink-300">（第 22 條）</span>
            <p className="mt-1 text-ink-200">
              主管機關換算減量成效、給每一批一組編碼，<b>核撥到你自己的官方額度帳戶</b>。
              到這裡你才真的「有碳權」。
            </p>
            <p className="mt-1 text-ink-300">
              注意核撥對象是<b>申請人自己</b>：法規沒有「發給代辦公司」這種設計。
              所以本站不代持國內額度，它從頭到尾都在你的帳戶裡。
            </p>
          </li>
        </ol>

        {/* ── 五大類 ───────────────────────────────────────────── */}
        <h3 className="pt-2 font-display text-base font-semibold text-ink-50">你的專案屬於哪一類，就會卡在哪裡</h3>
        <p>
          先說一件會省下很多時間的事：<b>你習慣的分類，和政府清單的分類不是同一套。</b>
          做減碳的人按技術講（「我們是做沼氣的」），政府清單按<b>產業別</b>排——
          臺灣分成 B-1 到 B-14：能源工業、能源輸配業、能源需求業、製造工業、化學製造業、建築業、運輸業、
          礦業、金屬製造業、燃料逸散、鹵化物及氟硫化物逸散、溶劑之使用、廢棄物處理及棄置、造林與植林。
          兩套對不齊是常態（例如那張表裡<b>沒有農業這一類</b>），找算法時要照政府的分類去翻。
        </p>
        <p>
          下面按五個技術大類整理。每一類最後一行是<b>這一類最容易被退件的地方</b>——
          那通常不是技術問題，而是外加性、基線或監測沒設計好，值得在動筆寫計畫書之前先看一眼。
        </p>
        <div className="space-y-3">
          {METHOD_FAMILIES.map((f, i) => (
            <div key={f.key} className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
              <div className="flex items-baseline gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink-600 text-xs font-semibold text-ink-200">
                  {i + 1}
                </span>
                <h4 className="font-display text-sm font-semibold text-ink-50">{f.title}</h4>
              </div>
              <p className="mt-2 text-sm leading-6 text-ink-200"><Rich text={f.lead} /></p>
              <dl className="mt-3 space-y-1.5 text-xs leading-6">
                <div className="sm:flex sm:gap-3">
                  <dt className="shrink-0 text-ink-300 sm:w-28">典型專案</dt>
                  <dd className="text-ink-200"><Rich text={f.examples} /></dd>
                </div>
                <div className="sm:flex sm:gap-3">
                  <dt className="shrink-0 text-ink-300 sm:w-28">臺灣歸在哪類</dt>
                  <dd className="text-ink-200"><Rich text={f.tw} /></dd>
                </div>
                <div className="sm:flex sm:gap-3">
                  <dt className="shrink-0 text-ink-300 sm:w-28">澳洲的對應方法</dt>
                  <dd className="text-ink-200"><Rich text={f.au} /></dd>
                </div>
              </dl>
              <p className="mt-3 border-t border-ink-500 pt-3 text-xs leading-6 text-ink-300">
                <b className="text-warn">最容易被退件的地方：</b>
                <Rich text={f.catch} />
              </p>
            </div>
          ))}
        </div>

        {/* ── 換一個國家申請 ────────────────────────────────────── */}
        <h3 className="pt-2 font-display text-base font-semibold text-ink-50">想在別的國家申請？</h3>
        <p>
          可以，而且很常見——專案在哪個國家，就走那個國家的制度。但要知道兩件事：
          <b>算法不通用</b>，同一座鍋爐改燒天然氣，臺灣 TCER 與日本 J-Credit 的基線設定和監測頻率可能完全不同；
          而且<b>發給你的額度，能拿去哪裡申報也不一樣</b>（見<a className="text-tide underline" href="#use">能用在哪</a>）。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink-300">
              <tr className="border-b border-ink-500">
                <th className="py-2 pr-3 font-medium">轄區</th>
                <th className="py-2 pr-3 font-medium">算法叫什麼</th>
                <th className="py-2 font-medium">誰審定、去哪裡查</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-500">
              {[
                ["🇹🇼 臺灣", "減量方法", "環境部審定後公開於指定資訊平台（第 12 條）；查詢系統另註明版次依 CDM 最新公告版為準"],
                ["🇯🇵 日本", "方法論", "經產・環境・農水三省的 J-Credit 制度委員會，公告於 J-Credit 官網"],
                ["🇰🇷 韓國", "외부사업 방법론", "環境部溫室氣體綜合資訊中心（GIR），公告於抵換登錄系統"],
                ["🇹🇭 泰國", "T-VER methodology", "TGO 審定並公告於 T-VER 網站"],
                ["🇮🇩 印尼", "metodologi SPE-GRK", "環境部依 SRN PPI 的機制文件核可"],
                ["🇦🇺 澳洲", "method determination", "Clean Energy Regulator。官方定義是「一套在 ACCU 機制下執行專案的要求與規則」，明定可做哪些活動、如何量測、以及監測與紀錄義務"],
              ].map(([c, m, who]) => (
                <tr key={c} className="text-ink-200">
                  <td className="whitespace-nowrap py-2 pr-3 text-ink-50">{c}</td>
                  <td className="whitespace-nowrap py-2 pr-3">{m}</td>
                  <td className="py-2">{who}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-ink-300">
          清單會增修，所以這裡不列數量與內容——請以各該登錄簿<b>當時</b>公告的版本為準，
          並記住你註冊時用的是<b>哪一版</b>，那一版會跟著專案一路走到查證。
        </p>

        {/* ── 三份 ISO ─────────────────────────────────────────── */}
        <h3 className="pt-2 font-display text-base font-semibold text-ink-50">那 ISO 14064 在這條路的哪裡</h3>
        <p>
          很多人以為「做了 ISO 14064 就有碳權」，這是不成立的。
          ISO 規定的是<b>品質</b>，政府決定的是<b>能不能換到額度</b>：
        </p>
        <ul className="space-y-1.5 border-l-2 border-ink-500 pl-4">
          <li><b>ISO 14064-2</b>——一份專案報告要寫到什麼程度才算完整：邊界、基線、資料品質、怎麼記錄績效。對應上面的第 ③ 與第 ⑥ 步。</li>
          <li><b>ISO 14064-3</b>——查的人要怎麼查、查到什麼程度、聲明怎麼寫。對應第 ④ 與第 ⑦ 步。</li>
          <li><b>各國自願減量辦法</b>——交給誰、用哪一套算法、額度發給誰、編碼長什麼樣。對應第 ②、⑤、⑧ 步。</li>
        </ul>
        <p className="text-ink-300">
          所以一份只符合 ISO 14064-2 的報告，本身<b>不是</b>碳權，也賣不掉。
          它要進到某一國的機制裡，由該國認可的查驗機構查過、該國主管機關核發，才會有序號、才進得了登錄簿。
        </p>

        {/* ── 第二段：上架 ─────────────────────────────────────── */}
        <h3 className="pt-2 font-display text-base font-semibold text-ink-50">第二段：拿到碳權之後，在這裡上架賣</h3>
        <p>
          到這一步你手上已經有政府核發的額度了。接下來看它是<b>臺灣核發</b>還是<b>其他國家核發</b>，
          兩條路的差別只有一個：額度放在誰的帳戶裡。
        </p>

        <Example title="臺灣核發的額度（TCER）">
          <p>
            額度留在<b>你自己</b>的環境部額度帳戶，從上架到最終註銷都不會動——
            因為法規上的「移轉」只有「交易完成後由主管機關辦理」這一種，沒有為了保管而移轉的類型。
          </p>
          <ol className="mt-1 space-y-1">
            <li>1. 在<a className="text-tide underline" href="/kyc">身分驗證</a>完成<b>法人</b>驗證。</li>
            <li>2. 到<a className="text-tide underline" href="/enterprise">企業</a>頁<b>登錄專案</b>：名稱、用的方法學、地點、專案文件連結。</li>
            <li>3. 同一頁<b>申請核發</b>：選專案、填監測起迄與噸數、上傳 ISO 14064-3 的<b>查驗報告 PDF</b>。</li>
            <li>4. 查驗機構在鏈上<b>簽章核發</b>，你會拿到一批帶唯一序號的額度。</li>
            <li>5. <b>掛單</b>：填數量、每噸價格、最小成交量與使用期限，送出後就出現在掛單簿上。</li>
          </ol>
          <p className="mt-1 text-ink-300">
            買方在這裡買到的是<b>對那批額度的請求權</b>。等他要實際使用時，才辦那唯一一次官方移轉：
            從你的帳戶直接到買方帳戶，由主管機關執行。所以<b>你有配合過戶的契約義務</b>——
            不配合會失去上架資格並被追繳已減免的代辦費。
          </p>
        </Example>

        <Example title="其他國家核發的額度（J-Credit、KOC、T-VER、SPE-GRK、ACCU）">
          <p>
            這些國家的法規允許以託管帳戶持有，所以流程多一步：額度依該國登錄簿的規則，
            移轉到<b>本公司在該國官方登錄簿開立的託管帳戶</b>。額度<b>自始至終留在該國政府的登錄簿裡</b>，
            本公司的自有錢包不持有任何額度。之後的登錄專案、核發、掛單與臺灣額度相同。
          </p>
          <p className="mt-1 text-ink-300">
            目前開放掛單的是日本 J-Credit、韓國 KOC、泰國 T-VER、印尼 SPE-GRK、澳洲 ACCU。
            中國 CCER 與印度 CCC 在本站<b>只顯示、不開放掛單</b>——不是技術限制，是那兩國的跨境使用規定還沒訂。
            每月 5 日本站會公開<a className="text-tide underline" href="/custody">託管與準備金對帳報告</a>，由查核機構簽署。
          </p>
        </Example>

        <Notice>
          <b>Phase 0 展示版本：</b>本站的查驗機構簽章、身分驗證與結算幣<b>皆為模擬</b>，
          站上的額度<b>不具法律效力，不得作為任何申報依據</b>。
          上面第一段（政府核發）描述的是真實制度，第二段描述的是本站的實際操作流程；
          正式營運還缺主管機關認可、查驗機構以自己的金鑰簽章，以及金融機構提供的結算工具。
        </Notice>
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
          <Link className="text-tide underline" href="/agreements/service-flow">服務流程說明書</Link>裡。
        </p>
        {/*
          Phase 0 聲明已經在每一頁的頁尾，這裡不再重複；留下的是頁尾沒有說、
          而這一頁該說的那一句——正式營運缺的是什麼。
        */}
        <p className="text-xs leading-6 text-ink-300">
          正式營運的前提是主管機關認可、查驗機構以自己的金鑰簽章，以及金融機構提供的結算工具。
        </p>
      </Section>

      {/* ── 錢包原理與事故處理 ─────────────────────────────────────── */}
      <Section id="wallet" eyebrow="你的錢包怎麼運作" title="一個登入帳號一個錢包，一個錢包好幾把鑰匙">
        <p>
          你在本站的資產放在一個<b>鏈上錢包</b>裡。它不是平台幫你保管的一個欄位，
          而是區塊鏈上一份屬於你的合約——平台動不了它，只能替你把你簽好的指令送上鏈並代付手續費。
        </p>
        <p>
          這裡有三件常被混為一談的事，分開講：
        </p>
        <ul className="space-y-2 border-l-2 border-ink-500 pl-4">
          <li>
            <b>登入</b>（Google／Apple）決定你的錢包<b>是哪一個</b>。地址由登入帳號算出來，
            所以你換手機、換電腦、清掉瀏覽器資料，地址都不變，裡面的碳權也不會跟丟。
          </li>
          <li>
            <b>passkey</b>（Face ID／Touch ID／螢幕鎖）決定<b>誰能動它</b>。私鑰鎖在裝置的安全元件裡，
            平台拿不到、複製不走，也無法代你簽字。
          </li>
          <li>
            <b>這台裝置</b>有沒有一把有效的 passkey，決定你<b>在這裡</b>能不能簽字。
            只登入而沒有鑰匙的人，看得到餘額，動不了一分錢。
          </li>
        </ul>
        <p>
          一個錢包可以同時登錄<b>好幾把</b> passkey：手機一把、筆電一把、公司電腦一把。
          任何一把都能單獨下單，任何一把也能被撤掉。
          加一把新的<b>一定</b>要用現有的那一把簽字核准——這條規則就是「登入帳號被盜 ≠ 錢包被盜」的全部依據。
        </p>

        <Example title="四種事故，四條路">
          <p>
            <b>① 手機掉了，筆電還在。</b> 用筆電把手機那把撤掉。即時生效，不需要平台、不需要任何人。
            這也是為什麼建議你一開始就在兩台裝置上各放一把。
          </p>
          <p>
            <b>② 所有裝置都掉了。</b> 這時沒有任何人能代你簽字，包括平台。
            走復原程序：與平台聯絡並<b>重新通過身分驗證</b>（跟當初開戶同一套，不是「登入一次」），
            治理方多簽提案把新裝置的 passkey 加進來，<b>等 72 小時</b>才生效。
            期間你手上任何一把現存 passkey 都能一鍵否決。完成後<b>地址不變</b>，持倉與憑證都還在。
          </p>
          <p>
            <b>③ 登入帳號被盜。</b> 他登得進來、看得到你的持倉，但<b>簽不了字</b>——私鑰在你的裝置裡。
            他也不能把自己的 passkey 加進來（那要現有金鑰簽字）。他唯一做得到的是按下<b>凍結</b>，
            讓你暫時不能交易；而解凍要一把現存 passkey，他沒有。請立刻改密碼、開第二因素，然後自己解凍。
          </p>
          <p>
            <b>④ passkey 被盜（裝置被拿走而且解得開）。</b> 用別台裝置撤掉它。
            來不及的話先<b>凍結</b>止血——凍結只要登得進來就按得下去，因為需要它的那一刻你手邊多半已經沒有那台裝置了。
            凍結期間仍然可以撤金鑰、加新裝置、再解凍。
          </p>
        </Example>

        <p className="text-ink-300">
          兩個門檻刻意不對稱：<b>凍結</b>（往安全的方向動）只要登入就能做，<b>解凍</b>（往開鎖的方向動）
          一定要 passkey。所以拿到你登入權的人最多讓你不方便，不能把你關在門外。
          同樣地，復原提案只有治理方能提、要等待期、而且會被你否決——平台單方面拿不走你的錢包，
          而且每一步都在鏈上，任何人都查得到。
        </p>
        <p className="text-xs leading-6 text-ink-300">
          條文見<Link className="text-tide underline" href="/agreements/platform-terms">平台使用約定書</Link>第五條；
          管理你自己的裝置在<Link className="text-tide underline" href="/account">裝置與安全</Link>。
        </p>
      </Section>
        </div>
      </div>
    </div>
  );
}
