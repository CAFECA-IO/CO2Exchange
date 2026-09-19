"use client";
import { useEffect, useState } from "react";
import { PriceChart } from "./PriceChart";
import { Delta } from "./ui";
import type { Ticker } from "@/lib/server/ticker";

const RANGES = [
  { label: "24H", hours: 24 },
  { label: "7D", hours: 24 * 7 },
  { label: "30D", hours: 24 * 30 },
  { label: "90D", hours: 24 * 90 },
  { label: "1Y", hours: 24 * 365 },
] as const;

const fmtPrice = (v: number | null) =>
  v == null ? "—" : (v / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 0 });
const fmtTonne = (kg: number) => (kg / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 1 });

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-ink-300">{label}</div>
      <div className="tnum mt-0.5 text-sm font-medium text-ink-50">{children}</div>
    </div>
  );
}

export function MarketPanel() {
  const [hours, setHours] = useState<number>(24 * 7);
  const [t, setT] = useState<Ticker | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true);
      try {
        const d = await (await fetch(`/api/market/ticker?hours=${hours}`)).json();
        if (!live) return;
        if (d.error) setErr(d.error);
        else { setT(d); setErr(null); }
      } catch (e) {
        if (live) setErr(String(e));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [hours]);

  const up = (t?.changePct ?? 0) >= 0;

  return (
    <section className="space-y-3">
      {/* 報價列 */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-ink-300">
            <span className="rounded bg-ink-600 px-1.5 py-0.5 font-display font-medium tracking-wide text-tide">
              {t?.pair ?? "CCT / mTWD"}
            </span>
            <span>減量額度成交價 · 每公噸 CO₂e</span>
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            {/* 英雄數字用比例字寬，不用 tabular-nums */}
            <span className={`font-display text-4xl font-bold ${up ? "text-up" : "text-down"}`}>
              {fmtPrice(t?.last ?? null)}
            </span>
            <span className="text-sm text-ink-300">mTWD</span>
            {t?.changePct != null && (
              <span className="text-sm font-medium">
                <Delta value={t.changePct} />
                <span className="ml-2 text-ink-300">
                  ({t.change != null && t.change > 0 ? "+" : ""}
                  {fmtPrice(t.change)})
                </span>
              </span>
            )}
          </div>
        </div>

        {/* 時間範圍：單一列，放在圖表上方 */}
        <div className="flex gap-1 rounded-[--radius-ctl] border border-ink-500 bg-ink-700 p-1">
          {RANGES.map((r) => (
            <button
              key={r.label}
              onClick={() => setHours(r.hours)}
              className={`rounded px-3 py-1 text-xs font-medium transition ${
                hours === r.hours ? "bg-tide text-ink-900" : "text-ink-300 hover:bg-ink-600 hover:text-ink-50"
              }`}
              aria-pressed={hours === r.hours}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* 統計列 */}
      <div className={`grid grid-cols-2 gap-4 rounded-[--radius-card] border border-ink-500 bg-ink-700 px-4 py-3 ${t?.carbonFeePerTonne ? "sm:grid-cols-6" : "sm:grid-cols-5"}`}>
        <Stat label="區間高">{fmtPrice(t?.high ?? null)}</Stat>
        <Stat label="區間低">{fmtPrice(t?.low ?? null)}</Stat>
        <Stat label="成交量">{t ? `${fmtTonne(t.volumeKg)} 噸` : "—"}</Stat>
        <Stat label="成交金額">{t ? `${(t.volumeTwd / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 0 })} mTWD` : "—"}</Stat>
        <Stat label="成交筆數">{t?.tradeCount ?? "—"}</Stat>
        {/* 碳費是經濟錨點：額度貴過碳費，企業就寧可繳費不買額度 */}
        {t?.carbonFeePerTonne != null && (
          <Stat label="碳費費率">
            <span className="text-warn">{fmtPrice(t.carbonFeePerTonne)}</span>
          </Stat>
        )}
      </div>

      {/* 圖表：refetch 時保留前一次的畫面，降低不透明度，不要骨架閃動 */}
      <div className={loading && t ? "opacity-60 transition-opacity" : "transition-opacity"}>
        {err ? (
          <div className="rounded-[--radius-card] border border-down/40 bg-down/10 px-4 py-6 text-sm text-down">{err}</div>
        ) : t ? (
          <PriceChart candles={t.candles} referencePrice={t.carbonFeePerTonne} />
        ) : (
          <div className="h-[320px] rounded-[--radius-card] border border-ink-500 bg-ink-700" />
        )}
      </div>

      {/* 最近成交明細——交易所的成交回報，同時也是圖表的表格檢視 */}
      {t && t.trades.length > 0 && (
        <details className="rounded-[--radius-card] border border-ink-500 bg-ink-700">
          <summary className="cursor-pointer px-4 py-2 text-xs text-ink-300 hover:text-ink-50">
            最近成交明細（{t.trades.length} 筆）
          </summary>
          <div className="max-h-64 overflow-auto border-t border-ink-500">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-ink-600 text-left text-ink-300">
                <tr>
                  <th className="px-4 py-2 font-medium">時間</th>
                  <th className="px-3 py-2 text-right font-medium">成交價 / 噸</th>
                  <th className="px-3 py-2 text-right font-medium">數量</th>
                  <th className="px-4 py-2 text-right font-medium">金額</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-500">
                {t.trades.map((tr) => (
                  <tr key={tr.txHash + tr.ts} className="text-ink-200">
                    <td className="px-4 py-1.5 whitespace-nowrap">
                      {new Date(tr.ts * 1000).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="tnum px-3 py-1.5 text-right">{fmtPrice(tr.pricePerTonne)}</td>
                    <td className="tnum px-3 py-1.5 text-right">{fmtTonne(tr.kg)} 噸</td>
                    <td className="tnum px-4 py-1.5 text-right">{(tr.cost / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 0 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <p className="text-[11px] leading-5 text-ink-300">
        行情由鏈上 <code className="text-ink-200">Listing</code> 的成交事件即時推導，沒有任何模擬報價；
        每一根 K 棒都對應得到實際的交易雜湊。Phase 0 為展示環境，價格不代表任何真實市場。
      </p>
    </section>
  );
}
