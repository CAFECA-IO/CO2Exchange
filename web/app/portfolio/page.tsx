"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount } from "@/components/AccountProvider";
import { AccountGate } from "@/components/AccountGate";
import { AreaChart, BarList, Donut, StatTile } from "@/components/charts";
import { Card, Notice, fmtKg } from "@/components/ui";
import { useReload } from "@/lib/client/useReload";
import type { Movement, Portfolio } from "@/lib/server/portfolio";

/// 我的資產。
///
/// 使用者真正想知道的只有四件事：我有多少錢、我有多少碳權、我買的成本多少、
/// 現在是賺是賠。所以這四個放最上面的數字磚，圖表在下面補脈絡，明細在最底下。
///
/// 損益拆成已實現與未實現兩個數字，不要合成一個「總損益」就算了——
/// 賣掉賺的錢和帳面上的浮盈，性質完全不同。

const twd = (v: number) => (v / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 0 });
const twd2 = (v: number) => (v / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 2 });
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${twd2(Math.abs(v))}`;
const KIND: Record<Movement["kind"], string> = { issue: "核發取得", buy: "買進", sell: "賣出", retire: "註銷" };

export default function PortfolioPage() {
  const { credential, userId } = useAccount();
  const [p, setP] = useState<Portfolio | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey] = useReload();

  useEffect(() => {
    if (!credential) return;
    let ignore = false;
    (async () => {
      const r = await fetch(`/api/portfolio?account=${credential.address}`);
      const j = await r.json();
      if (ignore) return;
      if (!r.ok) setErr(j.error ?? "讀取失敗");
      else { setP(j); setErr(null); }
    })();
    return () => { ignore = true; };
  }, [credential, reloadKey]);

  if (!userId || !credential) return <AccountGate />;

  const totalPnl = p ? p.realisedPnl + (p.unrealisedPnl ?? 0) : 0;
  const pnlPct = p && p.costOfHolding > 0 && p.unrealisedPnl != null ? (p.unrealisedPnl / p.costOfHolding) * 100 : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-tide">我的資產</p>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-ink-50">資產總覽</h1>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/trade" className="rounded-[--radius-ctl] bg-tide px-3 py-1.5 font-medium text-ink-900">去交易</Link>
          <Link href="/retire" className="rounded-[--radius-ctl] border border-ink-500 px-3 py-1.5 text-ink-200 transition hover:border-tide/60">去註銷</Link>
        </div>
      </div>

      {err && <Notice kind="error">{err}</Notice>}
      {!p ? <p className="text-sm text-ink-300">讀取中…</p> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="資產總值" value={`${twd(p.totalValue)} mTWD`} sub="現金 + 碳權市值" />
            <StatTile label="可用現金" value={`${twd(p.twd)} mTWD`} sub="結算幣餘額" />
            <StatTile
              label="持有碳權"
              value={fmtKg(p.holdingKg)}
              sub={p.avgCostPerTonne ? `平均成本 ${twd2(p.avgCostPerTonne)} / 噸` : "無買入成本（核發取得）"}
            />
            <StatTile
              label="總損益"
              value={`${signed(totalPnl)} mTWD`}
              accent={totalPnl > 0 ? "up" : totalPnl < 0 ? "down" : "neutral"}
              sub={`已實現 ${signed(p.realisedPnl)}．未實現 ${p.unrealisedPnl == null ? "—" : signed(p.unrealisedPnl)}`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_1.25fr]">
            <Card title="資產配置">
              <Donut
                slices={[
                  { label: "碳權市值", value: p.marketValue, hint: `${twd(p.marketValue)} mTWD` },
                  { label: "現金 mTWD", value: p.twd, hint: `${twd(p.twd)} mTWD` },
                ]}
                centerLabel="資產總值"
                centerValue={twd(p.totalValue)}
              />
              <dl className="mt-4 space-y-1.5 border-t border-ink-500 pt-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-ink-300">目前市價</dt>
                  <dd className="tnum text-ink-50">{p.marketPricePerTonne ? `${twd2(p.marketPricePerTonne)} mTWD / 噸` : "尚無成交"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-300">平均成本</dt>
                  <dd className="tnum text-ink-50">{p.avgCostPerTonne ? `${twd2(p.avgCostPerTonne)} mTWD / 噸` : "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-300">未實現損益</dt>
                  <dd className={`tnum ${(p.unrealisedPnl ?? 0) > 0 ? "text-up" : (p.unrealisedPnl ?? 0) < 0 ? "text-down" : "text-ink-200"}`}>
                    {p.unrealisedPnl == null ? "—" : `${signed(p.unrealisedPnl)}${pnlPct != null ? `（${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(1)}%）` : ""}`}
                  </dd>
                </div>
              </dl>
              {p.issuedKg > 0 && (
                <p className="mt-3 text-xs leading-6 text-ink-300">
                  其中 {fmtKg(p.issuedKg)} 為專案核發取得，成本以 0 計（代辦費不在鏈上，算進來只會是假的精確），
                  因此平均成本與損益會偏樂觀。
                </p>
              )}
            </Card>

            <Card title="淨值走勢">
              <p className="mb-2 text-xs text-ink-300">
                每一次買賣之後的「現金流 + 持有市值」。起點為 0，看的是相對變化而不是絕對金額。
              </p>
              {p.equityCurve.length < 2 ? (
                <p className="flex h-[180px] items-center justify-center text-sm text-ink-300">
                  還需要至少兩筆異動才畫得出走勢。
                </p>
              ) : (
                <AreaChart
                  points={p.equityCurve.map((e) => ({ t: e.t, v: e.v / 1e6 }))}
                  format={(v) => v.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}
                  label="mTWD"
                />
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="持有明細">
              <BarList
                unit=" 噸"
                rows={[
                  ...p.batches.map((b) => ({
                    label: `批次 #${b.batchId}　${b.project}`,
                    value: b.kg / 1000,
                    hint: `${b.vintageYear} 年份`,
                  })),
                  ...(p.cctKg > 0 ? [{ label: "池化額度 CCT", value: p.cctKg / 1000, hint: "註銷時依 FIFO 對應到具體批次" }] : []),
                ]}
              />
            </Card>

            <Card title="交易明細">
              {p.movements.length === 0 ? <p className="text-sm text-ink-300">還沒有任何異動。</p> : (
                <div className="max-h-[340px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-ink-700 text-left text-xs uppercase tracking-wider text-ink-300">
                      <tr className="border-b border-ink-500">
                        <th className="py-2 pr-3 font-medium">時間</th>
                        <th className="py-2 pr-3 font-medium">類別</th>
                        <th className="py-2 pr-3 text-right font-medium">數量</th>
                        <th className="py-2 pr-3 text-right font-medium">單價</th>
                        <th className="py-2 text-right font-medium">金額</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-500">
                      {p.movements.map((m, i) => (
                        <tr key={`${m.txHash}-${i}`} className="text-ink-200">
                          <td className="py-2 pr-3 whitespace-nowrap text-ink-300">
                            {new Date(m.ts * 1000).toLocaleDateString("zh-TW")}
                          </td>
                          <td className="py-2 pr-3">
                            <span className={m.kind === "buy" ? "text-up" : m.kind === "sell" ? "text-down" : ""}>{KIND[m.kind]}</span>
                            <span className="ml-1 text-xs text-ink-300">#{m.batchId}</span>
                          </td>
                          <td className="tnum py-2 pr-3 text-right">{fmtKg(m.kg)}</td>
                          <td className="tnum py-2 pr-3 text-right">{m.pricePerTonne ? twd2(m.pricePerTonne) : "—"}</td>
                          <td className={`tnum py-2 text-right ${m.cashDelta > 0 ? "text-up" : m.cashDelta < 0 ? "text-down" : "text-ink-300"}`}>
                            {m.cashDelta === 0 ? "—" : signed(m.cashDelta)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <p className="text-xs leading-6 text-ink-300">
            損益以移動加權平均成本計算：賣出時認列已實現損益，剩下的部位以最近成交價估算未實現損益。
            註銷會把該部分成本從部位中扣除，但不計入損益——那是「用掉」，不是「賣掉」。
            Phase 0 的結算幣為測試代幣，數字不代表任何真實金額。
          </p>
        </>
      )}
    </div>
  );
}
