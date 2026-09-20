"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { GlobeCountry } from "@/components/Globe";

/// 地球是純瀏覽器的東西（canvas、rAF、DecompressionStream），伺服器端算不出來，
/// 所以動態載入並關掉 SSR。地球還沒到之前，右邊的清單已經是完整可用的頁面——
/// 那份清單不是「退而求其次」，它才是精確的那一份，地球是它的地理版本。
const Globe = dynamic(() => import("@/components/Globe"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse rounded-full bg-ink-600/40" />,
});

export type CountryRow = {
  country: string;
  name: string;
  scheme: string;
  registryName: string;
  enabled: boolean;
  lat: number;
  lon: number;
  issuedKg: number;
  circulatingKg: number;
  retiredKg: number;
  tradedKg: number;
  trades: number;
  listedKg: number;
  orders: number;
};

/// 一次只看一個量。三個量的數量級差很遠（核發是累計、交易是區間、掛單是當下），
/// 疊在同一張圖上就得畫兩把尺，而讀者無法從一根柱子判斷它用的是哪一把。
const MEASURES = [
  { key: "issuedKg", label: "核發量", hint: "各轄區累計核發的額度總量" },
  { key: "tradedKg", label: "交易量", hint: "近一年在本站成交的數量" },
  { key: "listedKg", label: "掛單量", hint: "目前掛單簿上待成交的數量" },
] as const;
type MeasureKey = (typeof MEASURES)[number]["key"];

const t = (kg: number) => (kg / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 0 });

/// 國旗用區域指示符號組出來，不放圖檔：兩個字母就是一面旗，
/// 而且沒有字型的平台會退回顯示 "TW" 這兩個字母，不會變成豆腐。
const flag = (cc: string) =>
  String.fromCodePoint(...[...cc.toUpperCase()].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));

function StatusChip({ enabled, issued }: { enabled: boolean; issued: number }) {
  if (enabled) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-tide/40 px-1.5 py-0.5 text-[10px] text-tide">
        <span className="h-1.5 w-1.5 rounded-full bg-tide" aria-hidden />開放交易
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-ink-500 px-1.5 py-0.5 text-[10px] text-ink-300">
      <span className="h-1.5 w-1.5 rounded-full border border-ink-300" aria-hidden />
      {issued > 0 ? "已停止上架" : "尚未開放"}
    </span>
  );
}

export default function GlobeHero() {
  const [rows, setRows] = useState<CountryRow[] | null>(null);
  const [err, setErr] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [measure, setMeasure] = useState<MeasureKey>("issuedKg");

  useEffect(() => {
    let alive = true;
    fetch("/api/market/by-country?hours=8760")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => alive && setRows(d.countries))
      .catch(() => alive && setErr(true));
    return () => { alive = false; };
  }, []);

  const meta = MEASURES.find((m) => m.key === measure)!;
  const sorted = useMemo(
    () => (rows ?? []).slice().sort((a, b) => b[measure] - a[measure] || a.country.localeCompare(b.country)),
    [rows, measure],
  );
  const max = useMemo(() => Math.max(1, ...sorted.map((r) => r[measure])), [sorted, measure]);
  const globeCountries: GlobeCountry[] = useMemo(
    () => sorted.map((r) => ({ country: r.country, name: r.name, enabled: r.enabled, lat: r.lat, lon: r.lon, value: r[measure] })),
    [sorted, measure],
  );

  const totals = useMemo(() => {
    const s = (k: MeasureKey) => sorted.reduce((a, r) => a + r[k], 0);
    return { issued: s("issuedKg"), traded: s("tradedKg"), listed: s("listedKg"), open: sorted.filter((r) => r.enabled).length };
  }, [sorted]);

  const sel = selected ? sorted.find((r) => r.country === selected) ?? null : null;

  return (
    <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
      {/* ── 地球 ─────────────────────────────────────────────────── */}
      <div className="relative">
        <div className="mx-auto aspect-square w-full max-w-[620px]">
          {rows && rows.length > 0 ? (
            <Globe
              countries={globeCountries}
              selected={selected}
              onSelect={setSelected}
              measureLabel={meta.label}
              className="h-full w-full"
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className={`h-3/4 w-3/4 rounded-full border border-ink-500 ${err ? "" : "animate-pulse"} bg-ink-700/40`} />
            </div>
          )}
        </div>
      </div>

      {/* ── 數據清單：精確的那一份 ────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-display text-lg font-semibold tracking-tight text-ink-50">各轄區的碳權</h2>
          <span className="text-xs text-ink-300">{totals.open} 個轄區開放交易</span>
        </div>

        <div role="group" aria-label="選擇要比較的量" className="flex rounded-ctl border border-ink-500 p-0.5">
          {MEASURES.map((m) => (
            <button
              key={m.key}
              onClick={() => setMeasure(m.key)}
              aria-pressed={measure === m.key}
              title={m.hint}
              className={`flex-1 rounded-[7px] px-2 py-1.5 text-xs transition ${
                measure === m.key ? "bg-tide/15 text-tide" : "text-ink-300 hover:text-ink-50"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {err ? (
          <p className="rounded-card border border-ink-500 p-4 text-sm text-ink-300">
            讀不到鏈上資料。請確認 RPC 已啟動，或稍後再試。
          </p>
        ) : !rows ? (
          <div className="space-y-2" aria-hidden>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-11 animate-pulse rounded-ctl bg-ink-600/40" />
            ))}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {sorted.map((r) => {
              const v = r[measure];
              const on = r.country === selected;
              return (
                <li key={r.country}>
                  <button
                    onClick={() => setSelected(on ? null : r.country)}
                    aria-pressed={on}
                    className={`w-full rounded-ctl px-2 py-1.5 text-left transition ${
                      on ? "bg-tide/10" : "hover:bg-ink-600"
                    }`}
                  >
                    <div className="flex items-baseline gap-2">
                      <span aria-hidden className="text-sm leading-none">{flag(r.country)}</span>
                      <span className="truncate text-sm text-ink-50">{r.name}</span>
                      <span className="shrink-0 text-[11px] text-ink-300">{r.scheme}</span>
                      <span className="ml-auto shrink-0 font-mono text-sm tabular-nums text-ink-50">
                        {v > 0 ? t(v) : "—"}
                        {v > 0 && <span className="ml-0.5 text-[10px] text-ink-300">噸</span>}
                      </span>
                    </div>
                    {/* 長條與數字都在，數字負責精確、長條負責一眼看出比例。
                        長條有 2px 的圓角端點並貼齊左邊的基準線，比例才讀得準。 */}
                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-ink-600">
                      <div
                        className={`h-full rounded-full ${r.enabled ? "bg-tide" : "bg-ink-300"}`}
                        style={{ width: `${Math.max(v > 0 ? 2 : 0, (v / max) * 100)}%` }}
                      />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* 選定之後的明細。點一個國家想知道的不只是剛剛那一個量。 */}
        {sel && (
          <div className="rounded-card border border-ink-500 bg-ink-700 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-ink-50">
                  <span aria-hidden className="mr-1.5">{flag(sel.country)}</span>{sel.name}
                </p>
                <p className="mt-0.5 text-xs text-ink-300">{sel.registryName || sel.scheme}</p>
              </div>
              <StatusChip enabled={sel.enabled} issued={sel.issuedKg} />
            </div>
            <dl className="mt-3 space-y-1.5 text-xs">
              {[
                ["累計核發", `${t(sel.issuedKg)} 噸`],
                ["鏈上流通", `${t(sel.circulatingKg)} 噸`],
                ["累計註銷", `${t(sel.retiredKg)} 噸`],
                ["近一年成交", `${t(sel.tradedKg)} 噸 · ${sel.trades} 筆`],
                ["掛單簿", `${t(sel.listedKg)} 噸 · ${sel.orders} 筆`],
              ].map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-ink-300">{k}</dt>
                  <dd className="truncate text-right font-mono tabular-nums text-ink-50">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {rows && rows.length > 0 && (
          <dl className="grid grid-cols-3 gap-2 border-t border-ink-500 pt-3 text-xs">
            {[
              ["全站核發", t(totals.issued)],
              ["近一年成交", t(totals.traded)],
              ["掛單簿", t(totals.listed)],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-ink-300">{k}</dt>
                <dd className="font-mono text-sm tabular-nums text-ink-50">{v}<span className="ml-0.5 text-[10px] text-ink-300">噸</span></dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}
