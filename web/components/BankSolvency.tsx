"use client";
import { useEffect, useState } from "react";
import { Card, Notice } from "./ui";
import { fetchJson } from "@/lib/client/fetchJson";

/// 帳本合約的償付能力揭露（規則第 4 版：新台幣版）。
///
/// 碳權與交易都在鏈下帳本，鏈上只放每小時一期的承諾與記帳用的 TWD。
/// 這讓交易不必等出塊、不必付 gas，但也表示**鏈上看不到個別持有人**。
///
/// 那個代價要用揭露補回來，而揭露只有在「可以自己算一次」的時候才算數：
///
///   · 帳本宣稱欠多少 —— 每小時提交一次的餘額樹，總額被 root 蓋住，改不掉
///   · 宣稱有多少 —— 新台幣是帳本合約裡的記帳 TWD（營運 Safe 確認入金時鑄、確認出金時銷毀，
///     不能轉出；總量＝營運方宣稱的信託專戶餘額）；碳權是登錄簿流通量（核發 − 註銷），由同一期的 registry root 蓋住
///
/// 兩個數字並列，不合併。新台幣差額為正是正常的（剛入金、還沒進到下一期）；
/// 為負則合約在提交時就擋下來（`Insolvent`）。
///
/// **這張表證明不了銀行裡真的有那麼多錢。**記帳 TWD 是營運方的宣稱；它和專戶餘額是否相符，
/// 靠信託銀行的對帳與查核機構的報告。這一句要寫在畫面上。
///
/// ## 沒有鏈上提領、沒有逃生門
///
/// 真的新台幣在信託專戶，不在合約裡，所以沒有任何東西可以從合約「領出來」。出金是營運方匯款後
/// 由營運 Safe 在鏈上確認；營運方停擺時，最後一期的證據是對本站與信託財產的債權憑證。

type Solvency = {
  address: string;
  epoch: string;
  head: string;
  token: string;
  tokenSupply: string;
  commitment: { balanceRoot: string; totalKg: string; totalCash: string; upToBlock: string; committedAt: string } | null;
  solvency: { owedKg: string; heldKg: string; owedCash: string; heldCash: string; surplusKg: string; surplusCash: string };
};

const kg = (v: string) => (Number(v) / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 1 });
const twd = (v: string) => (Number(v) / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 0 });
const short = (h: string) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");

/// `ledger` / `pool` 是**已經格式化過的字串**（含千分位），`short` 是外面算好的布林。
///
/// 第一版在這裡寫 `BigInt(pool) < BigInt(ledger)`——拿格式化後的字串去解析。
/// 數字小的時候沒有千分位，解析得過，測試也綠；金額一超過一千就變成
/// `Cannot convert 1,005 to a BigInt`，整個元件炸掉。
/// 格式化與比較要分開，不要讓顯示用的字串回頭當資料用。
function Row({ label, ledger, pool, unit, short }: { label: string; ledger: string; pool: string; unit: string; short: boolean }) {
  const short_ = short;
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-4 gap-y-1 py-1.5">
      <span className="text-ink-300">{label}</span>
      <span className="tnum text-right text-ink-50">
        {ledger}<span className="ml-1 text-[10px] text-ink-300">{unit}</span>
      </span>
      <span className={`tnum text-right ${short_ ? "text-down" : "text-ink-50"}`}>
        {pool}<span className="ml-1 text-[10px] text-ink-300">{unit}</span>
      </span>
    </div>
  );
}

export function BankSolvency() {
  const [d, setD] = useState<Solvency | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<Solvency>("/api/bank")
      .then(setD)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  if (err) {
    // 讀不到（節點斷線、還沒部署）講清楚原因，不報紅
    return (
      <Card title="帳本合約">
        <Notice>{err}</Notice>
      </Card>
    );
  }
  if (!d) return <Card title="帳本合約"><Notice>讀取中…</Notice></Card>;

  const s = d.solvency;
  return (
    <Card
      title="帳本合約：宣稱欠 vs 宣稱有"
      action={<span className="text-xs text-ink-300">第 {d.epoch} 期・每小時上鏈</span>}
    >
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 border-b border-ink-500 pb-1.5 text-[11px] text-ink-300">
        <span />
        <span className="text-right">帳本宣稱欠</span>
        <span className="text-right">登錄簿流通／記帳 TWD</span>
      </div>
      <div className="divide-y divide-ink-600 text-sm">
        <Row label="碳權" ledger={kg(s.owedKg)} pool={kg(s.heldKg)} unit="噸"
             short={BigInt(s.heldKg) < BigInt(s.owedKg)} />
        <Row label="新台幣" ledger={twd(s.owedCash)} pool={twd(s.heldCash)} unit="元"
             short={BigInt(s.heldCash) < BigInt(s.owedCash)} />
      </div>

      <dl className="mt-3 space-y-1 text-xs">
        <div className="flex justify-between gap-4">
          <dt className="text-ink-300">餘額樹 root</dt>
          <dd className="font-mono text-ink-200">{short(d.commitment?.balanceRoot ?? "")}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-300">承諾鏈 head</dt>
          <dd className="font-mono text-ink-200">{short(d.head)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-300">算到區塊</dt>
          <dd className="tnum text-ink-200">{d.commitment?.upToBlock ?? "—"}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-300">記帳 TWD</dt>
          <dd className="font-mono text-ink-200">{short(d.token)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-300">發行量</dt>
          <dd className={BigInt(d.tokenSupply) === BigInt(s.heldCash) ? "tnum text-ink-200" : "tnum text-warn"}>
            {twd(d.tokenSupply)} 元{BigInt(d.tokenSupply) === BigInt(s.heldCash) ? "（全部在帳本合約裡）" : "（⚠️ 與帳本合約持有的不同）"}
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-xs leading-6 text-ink-300">
        交易、登錄簿與身分都在鏈下帳本裡，鏈上看不到個別持有人。代價用這張表補回來：
        每小時把整份帳本壓成一期承諾（事件 log root、帶總額的餘額樹 root、登錄簿 root、身分 root）提交上鏈，
        並與前一期串連，事後改不掉。碳權流通量由登錄簿重播得出、同一期的 registry root 蓋住。兩個數字並列，不合併。
      </p>
      <p className="mt-2 text-xs leading-6 text-ink-300">
        <span className="text-ink-200">新台幣在信託專戶，不在鏈上。</span>
        右欄的新台幣是帳本合約裡的記帳 TWD：營運 Safe 依銀行對帳確認一筆入金時鑄出、確認一筆出金時銷毀，只存在合約裡、不能轉給任何人。
        它的總量是<span className="text-ink-200">營運方宣稱的</span>信託專戶餘額——
        <span className="text-ink-200">這張表證明不了銀行裡真的有那麼多錢</span>，那要靠信託銀行的對帳與查核機構的報告。
        它證明的是：帳本宣稱欠使用者的，不會超過營運方公開宣稱持有的（合約在提交時就擋下）；每一筆入出金都帶銀行交易參考號的雜湊，同一號不能用兩次。
      </p>
      <p className="mt-2 text-xs leading-6 text-ink-300">
        <span className="text-ink-200">法律性質。</span>
        新台幣預定存放於信託機構的信託專戶，與本站自有資金分離；碳權託管在核發國官方登錄簿的本站帳戶（商業託管），您對本站擁有返還請求權。
        帳本內成交是該請求權的讓與，不是額度本身的移轉——整個過程對一單位額度只發生一次官方移轉。
        <span className="text-ink-200">Phase 0 展示版本尚未開立信託專戶，畫面上的金額不代表任何真實資金。</span>
      </p>
      <p className="mt-2 text-xs leading-6 text-ink-300">
        <span className="text-ink-200">出金怎麼走：</span>
        設定收款帳戶（戶名須與身分驗證的名稱相同）→ 在帳本裡簽一則出金請求（那筆錢從可動用移到待出金，請求裡只記收款帳戶的雜湊）→
        下一期承諾上鏈 → 營運方匯款到您的收款帳戶 → 營運 Safe 憑最新一期的證據在鏈上確認。
        確認的金額不能超過您請求、且已進承諾的部分；營運方沒有匯款時可以退回請求，金額回到可動用。
      </p>
      <p className="mt-2 text-xs leading-6 text-ink-300">
        <span className="text-ink-200">營運方停擺時怎麼辦：</span>
        <span className="text-ink-200">沒有逃生門。</span>錢在信託專戶、不在合約裡，鏈上沒有任何機制能替您把錢或碳權領出來。
        最後一期的承諾與您的證據檔，是您對本站與信託財產的債權憑證，返還依信託契約與主管機關的程序辦理。
      </p>
      <p className="mt-2 text-xs leading-6 text-ink-300">
        <span className="text-ink-200">請保存您的證據檔。</span>
        交易頁可以下載，每一期的公開檔與完整帳本鏡像也同時交付查核機構與主管機關——
        如果產生證據的唯一途徑是本站的伺服器，那麼本站消失時證據也跟著消失，而那正是證據最需要的時候。
        詳見<a className="text-tide underline" href="/audit">審計</a>。
      </p>
      <p className="mt-2 text-xs leading-6 text-ink-300">
        這串數字不必相信本站：<code className="text-ink-200">npm run ledger:verify</code> 會從公開的事件 log 與鏈上承諾
        重新推導一次所有人的餘額、重建同一棵樹，對不上就 exit 1。
      </p>
    </Card>
  );
}
