"use client";
import { useEffect, useState } from "react";
import { Card, Notice } from "./ui";
import { fetchJson } from "@/lib/client/fetchJson";

/// 帳本合約的償付能力揭露。
///
/// 設計 v4：碳權與交易都在鏈下帳本，鏈上只放每小時一期的承諾與結算幣的託管。
/// 這讓交易不必等出塊、不必付 gas，但也表示**鏈上看不到個別持有人**。
///
/// 那個代價要用揭露補回來，而揭露只有在「可以自己算一次」的時候才算數：
///
///   · 帳本宣稱欠多少 —— 每小時提交一次的餘額樹，總額被 root 蓋住，改不掉
///   · 實際有多少 —— 結算幣是帳本合約的鏈上餘額；碳權是登錄簿流通量（核發 − 註銷），
///     由同一期的 registry root 蓋住
///
/// 兩個數字並列，不合併。合併之後就看不出兩者差在哪裡。
/// 結算幣差額為正是正常的（剛存進來、還沒進到下一期）；為負則合約在提交時就擋下來（`Insolvent`）。
///
/// ## 法律性質：商業託管，不是信託
///
/// 這一段要寫在畫面上，不能只寫在文件裡。結算幣登記在帳本合約名下，碳權登記在核發國登錄簿的
/// 託管帳戶，使用者對交易所有返還請求權。和信託的差別在出事的時候才看得出來——
/// 信託有法定的破產隔離，商業託管沒有同等的保障。所以「識別得出哪一份是誰的」與
/// 「拿得回來」只能靠機制撐：餘額樹負責前者，提領與逃生門負責後者。

type Solvency = {
  address: string;
  epoch: string;
  head: string;
  withdrawalsEnabled: boolean;
  escape: { active: boolean; inSeconds: string | null };
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
      title="帳本合約：宣稱欠 vs 實際有"
      action={<span className="text-xs text-ink-300">第 {d.epoch} 期・每小時上鏈</span>}
    >
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 border-b border-ink-500 pb-1.5 text-[11px] text-ink-300">
        <span />
        <span className="text-right">帳本宣稱欠</span>
        <span className="text-right">登錄簿／合約實際有</span>
      </div>
      <div className="divide-y divide-ink-600 text-sm">
        <Row label="碳權" ledger={kg(s.owedKg)} pool={kg(s.heldKg)} unit="噸"
             short={BigInt(s.heldKg) < BigInt(s.owedKg)} />
        <Row label="結算幣" ledger={twd(s.owedCash)} pool={twd(s.heldCash)} unit="元"
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
          <dt className="text-ink-300">提領</dt>
          <dd className="text-ink-200">{d.withdrawalsEnabled ? "開放" : "暫停（營運 Safe 的開關；逃生提領不受影響）"}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-300">逃生模式</dt>
          <dd className={d.escape.active ? "text-warn" : "text-ink-200"}>
            {d.escape.active
              ? "已開啟——營運方超過 72 小時沒有提交承諾"
              : d.escape.inSeconds === null
                ? "待第一期承諾"
                : `未開啟（${Math.ceil(Number(d.escape.inSeconds) / 3600)} 小時後開啟）`}
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-xs leading-6 text-ink-300">
        交易、登錄簿與身分都在鏈下帳本裡，鏈上看不到個別持有人。代價用這張表補回來：
        每小時把整份帳本壓成一期承諾（事件 log root、帶總額的餘額樹 root、登錄簿 root、身分 root）提交上鏈，
        並與前一期串連，事後改不掉。結算幣實際有多少是帳本合約的鏈上餘額；碳權流通量由登錄簿重播得出、
        同一期的 registry root 蓋住。兩個數字並列，不合併。
      </p>
      <p className="mt-2 text-xs leading-6 text-ink-300">
        <span className="text-ink-200">法律性質：商業託管。</span>
        結算幣託管在帳本合約名下，碳權託管在核發國官方登錄簿的本站帳戶，您對本站擁有返還請求權。
        帳本內成交是該請求權的讓與，不是額度本身的移轉——整個過程對一單位額度只發生一次官方移轉。
        這與信託不同：信託有法定的破產隔離，商業託管沒有同等保障。
        所以「識別得出哪一份是誰的」由每小時上鏈的餘額樹負責，「拿得回來」由提領機制負責。
        <span className="text-ink-200">這兩項不是附加保障，是這個法律性質下必要的補強。</span>
      </p>
      <p className="mt-2 text-xs leading-6 text-ink-300">
        <span className="text-ink-200">提領怎麼走：</span>
        先在帳本裡簽一則提領請求（那筆錢從可動用移到待提領），下一期承諾上鏈之後，憑最新一期的證據向合約領回。
        合約記每個帳戶累計領了多少，同一筆錢不會領到第二次。
      </p>
      <p className="mt-2 text-xs leading-6 text-ink-300">
        <span className="text-ink-200">營運方停擺時怎麼辦：</span>
        超過 72 小時沒有新的承諾上鏈，合約自動進入逃生模式——
        任何人都能憑最後一期的證據領回自己在帳本裡的全部結算幣（不必先申請），
        <span className="text-ink-200">不需要本站同意，本站也關不掉</span>（它只看「最後一次提交到現在過了多久」）。
        碳權則可在鏈上登記請求權（claimCredits），留下帶時間、改不掉的紀錄，由接手單位據以辦理官方移轉。
        合約不足時能領多少領多少，差額以 CashShortfall 事件記在鏈上，作為向本站請求補足的依據。
      </p>
      <p className="mt-2 text-xs leading-6 text-ink-300">
        <span className="text-ink-200">請保存您的證據檔。</span>
        逃生模式要能用，前提是您手上有自己的證據。交易頁可以下載，每一期的公開檔與完整帳本鏡像也同時交付查核機構與主管機關——
        如果產生證據的唯一途徑是本站的伺服器，那麼本站消失時證據也跟著消失，而那正是逃生門唯一會被用到的時候。
        詳見<a className="text-tide underline" href="/transparency">透明度與驗證</a>。
      </p>
      <p className="mt-2 text-xs leading-6 text-ink-300">
        這串數字不必相信本站：<code className="text-ink-200">npm run ledger:verify</code> 會從公開的事件 log 與鏈上承諾
        重新推導一次所有人的餘額、重建同一棵樹，對不上就 exit 1。
      </p>
    </Card>
  );
}
