"use client";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { fetchJson } from "@/lib/client/fetchJson";

type D = {
  marketMakers: string[]; platformAccounts: string[]; quoting: boolean; bidLevels: number; askLevels: number;
  simulation: { allowedOnThisChain: boolean; active: boolean; simulatedAccounts: number };
  rules: string[];
};

/// 平台做市與模擬交易的揭露。放在託管揭露頁：兩者回答的是同一類問題——
/// 「你看到的東西裡，哪些是平台自己的？」
export function MarketMakerDisclosure() {
  const [d, setD] = useState<D | null>(null);
  useEffect(() => { fetchJson<D>("/api/market/makers").then(setD).catch(() => setD(null)); }, []);
  if (!d) return null;
  return (
    <Card title="平台做市與模擬交易" className="scroll-mt-20">
      <div id="market-making" />
      <p className="text-sm leading-7 text-ink-200">
        為了讓買方與賣方隨時找得到對手，平台以自有資金設立做市帳戶，在參考價兩側掛出買單與賣單。
        做市帳戶的單在掛單簿上標示<span className="mx-1 rounded bg-tide/15 px-1.5 py-0.5 text-[11px] text-tide">平台做市</span>。
      </p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-200">{d.rules.map((r) => <li key={r}>{r}</li>)}</ul>
      <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-4"><dt className="text-ink-300">做市狀態</dt><dd className="text-ink-50">{d.quoting ? `報價中（買 ${d.bidLevels} 檔、賣 ${d.askLevels} 檔）` : "目前沒有報價"}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-ink-300">模擬交易</dt><dd className="text-ink-50">{!d.simulation.allowedOnThisChain ? "本鏈不允許" : d.simulation.active ? `執行中（${d.simulation.simulatedAccounts} 個模擬帳戶）` : d.simulation.simulatedAccounts ? `未執行（簿子上仍可能有 ${d.simulation.simulatedAccounts} 個模擬帳戶的單）` : "未執行"}</dd></div>
      </dl>
      {d.marketMakers.length > 0 && (
        <p className="mt-3 break-all font-mono text-xs text-ink-300">
          做市帳戶：{d.marketMakers.join("、")}
          {d.platformAccounts.length > 0 && <><br />營運金鑰：{d.platformAccounts.join("、")}</>}
        </p>
      )}
    </Card>
  );
}
