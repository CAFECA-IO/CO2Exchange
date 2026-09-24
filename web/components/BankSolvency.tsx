"use client";
import { useEffect, useState } from "react";
import { Card, Notice } from "./ui";
import { fetchJson } from "@/lib/client/fetchJson";

/// 平台資產池的償付能力揭露。
///
/// 使用者在交易所期間，碳權與結算幣都放在資產池（Bank 合約）裡，內部買賣是帳本更新。
/// 這讓交易不必等出塊、不必付 gas，但也表示**鏈上看不到個別持有人**——
/// 鏈上只看得到「池子裡有多少」。
///
/// 那個代價要用揭露補回來，而揭露只有在「可以自己算一次」的時候才算數：
///
///   · 帳本宣稱欠多少 —— 每 24 小時提交一次的餘額樹，總額被 root 蓋住，改不掉
///   · 池子裡實際有多少 —— 鏈上餘額，誰都查得到
///
/// 兩個數字並列，不合併。一樣的原則：合併之後就看不出兩者差在哪裡。
///
/// 差額為正是正常的（剛存進來、還沒進到下一期的樹裡）；為負則是資不抵債，
/// 而合約會在提交時就擋下來（`Insolvent`），所以它不該出現在這裡。
///
/// ## 法律性質：商業託管，不是信託
///
/// 這一段要寫在畫面上，不能只寫在文件裡。資產池的法律性質是**商業託管**：
/// 資產登記在 Bank 合約名下，使用者對交易所有返還請求權。
///
/// 和信託的差別在出事的時候才看得出來——信託有法定的破產隔離，商業託管沒有
/// 同等的保障。所以「識別得出哪一份是誰的」與「拿得回來」這兩件事不能靠法律地位撐，
/// 只能靠機制撐：餘額樹負責前者（每 24 小時把歸屬釘在鏈上），逃生門負責後者
/// （營運方不再提交 root 時，憑最後一個 root 仍然領得走）。
///
/// 換句話說，這兩個機制不是加分項，是這個法律性質下的**必要條件**。
/// 逃生門還沒做（C 期），所以畫面上誠實標示。
///
/// 注意不要和上面那一段混為一談：`/custody` 上半部講的是**國家級**託管——
/// 額度在核發國登錄簿、入金在信託專戶。那一層的入金是真的信託。

type Solvency = {
  address: string;
  epoch: string;
  head: string;
  withdrawalsEnabled: boolean;
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
    // 這條鏈還沒有資產池是正常狀態（舊部署），不是錯誤，所以講清楚而不是報紅。
    return (
      <Card title="平台資產池">
        <Notice>{err}</Notice>
      </Card>
    );
  }
  if (!d) return <Card title="平台資產池"><Notice>讀取中…</Notice></Card>;

  const s = d.solvency;
  return (
    <Card
      title="平台資產池：帳本 vs 池子"
      action={<span className="text-xs text-ink-300">第 {d.epoch} 期・每 24 小時上鏈</span>}
    >
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 border-b border-ink-500 pb-1.5 text-[11px] text-ink-300">
        <span />
        <span className="text-right">帳本宣稱欠</span>
        <span className="text-right">池子裡實際有</span>
      </div>
      <div className="divide-y divide-ink-600 text-sm">
        <Row label="碳權" ledger={kg(s.owedKg)} pool={kg(s.heldKg)} unit="噸"
             short={BigInt(s.heldKg) < BigInt(s.owedKg)} />
        <Row label="結算幣" ledger={twd(s.owedCash)} pool={twd(s.heldCash)} unit="mTWD"
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
          <dd className="text-ink-200">{d.withdrawalsEnabled ? "開放" : "尚未開放（機制已在鏈上）"}</dd>
        </div>
      </dl>

      <p className="mt-3 text-xs leading-6 text-ink-300">
        使用者在交易所期間，資產放在資產池裡，內部買賣是帳本更新——所以鏈上看不到個別持有人。
        代價用這張表補回來：每 24 小時把「誰有多少」壓成一棵帶總額的 Merkle 樹提交上鏈，
        總額被 root 蓋住，事後改不掉；池子裡實際有多少則是鏈上餘額，誰都查得到。
        兩個數字並列，不合併。
      </p>
      <p className="mt-2 text-xs leading-6 text-ink-300">
        <span className="text-ink-200">法律性質：商業託管。</span>
        資產登記在資產池合約名下，您對本站擁有返還請求權。
        這與信託不同——信託有法定的破產隔離，商業託管沒有同等保障。
        因此「識別得出哪一份是誰的」由上面那棵每日上鏈的餘額樹負責，
        「拿得回來」由提領機制負責（尚未開放，見下）。
        <span className="text-ink-200">這兩項不是附加保障，是這個法律性質下必要的補強。</span>
      </p>
      <p className="mt-2 text-xs leading-6 text-ink-300">
        這串數字不必相信本站：<code className="text-ink-200">npm run bank:verify</code> 會從鏈上事件
        重新推導一次所有人的餘額、重建同一棵樹，對不上就 exit 1。
        每一位使用者也拿得到自己那一份的 Merkle 分支。
      </p>
    </Card>
  );
}
