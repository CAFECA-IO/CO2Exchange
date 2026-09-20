"use client";
import { useId, useState } from "react";

/// 圖表基本件：甜甜圈、長條、面積折線、數字磚。
///
/// 全部手繪 SVG，沒有圖表套件——這個站的圖都很簡單，為它們拉一套相依不划算，
/// 而且顏色要跟著 CSS 變數走（深淺主題各一組），套件反而綁手綁腳。
///
/// 配色只用兩個經過驗證的類別色（--color-cat-1 / --color-cat-2）。這兩個色是拿
/// dataviz 的驗證器對深色面與淺色面各跑過亮度帶、彩度、色盲分離度與對比度的，
/// 不是挑順眼的。要加第三色請重跑驗證器。
///
/// 另外，每個圖都不靠顏色單獨傳達訊息：甜甜圈直接標數字、長條有數值、
/// 折線有十字準星讀數。色盲讀者不看顏色也讀得出來。

const CAT = ["var(--color-cat-1)", "var(--color-cat-2)"] as const;

export function StatTile({
  label, value, sub, accent, icon,
}: { label: string; value: string; sub?: string; accent?: "up" | "down" | "neutral"; icon?: React.ReactNode }) {
  const color = accent === "up" ? "text-up" : accent === "down" ? "text-down" : "text-ink-50";
  return (
    <div className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-300">
        {icon}
        {label}
      </div>
      <div className={`tnum mt-1 font-display text-2xl font-bold ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-300">{sub}</div>}
    </div>
  );
}

type Slice = { label: string; value: number; hint?: string };

/// 甜甜圈：只用在「部分對全體」且類別 ≤ 2–3 個的情形。
/// 類別更多時長條圖比較好讀，不要硬塞。
export function Donut({ slices, centerLabel, centerValue, size = 148 }: {
  slices: Slice[]; centerLabel?: string; centerValue?: string; size?: number;
}) {
  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  let acc = 0;
  const id = useId();

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="資產配置">
        <g transform={`translate(${size / 2} ${size / 2}) rotate(-90)`}>
          <circle r={r} fill="none" className="stroke-ink-600" strokeWidth={14} />
          {total > 0 && slices.map((s, i) => {
            const frac = Math.max(0, s.value) / total;
            // 2px 的表面色間隙，讓相鄰扇形不會糊在一起
            const dash = Math.max(0, c * frac - 2);
            const el = (
              <circle
                key={s.label}
                r={r}
                fill="none"
                stroke={CAT[i % CAT.length]}
                strokeWidth={14}
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={-acc * c}
              >
                <title>{`${s.label} ${(frac * 100).toFixed(1)}%`}</title>
              </circle>
            );
            acc += frac;
            return el;
          })}
        </g>
        {centerValue && (
          <text x={size / 2} y={size / 2 - 2} textAnchor="middle" className="tnum fill-ink-50 font-display" fontSize={18} fontWeight={700}>
            {centerValue}
          </text>
        )}
        {centerLabel && (
          <text x={size / 2} y={size / 2 + 16} textAnchor="middle" className="fill-ink-300" fontSize={11}>
            {centerLabel}
          </text>
        )}
      </svg>
      {/* 圖例兼直接標示：數字寫在文字上，不是只靠顏色 */}
      <ul className="space-y-2 text-sm">
        {slices.map((s, i) => (
          <li key={s.label} className="flex items-baseline gap-2">
            <span className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: CAT[i % CAT.length] }} aria-hidden />
            <span className="text-ink-200">{s.label}</span>
            <b className="tnum ml-auto pl-4 font-medium text-ink-50">
              {total > 0 ? `${((Math.max(0, s.value) / total) * 100).toFixed(1)}%` : "—"}
            </b>
            {s.hint && <span className="tnum text-xs text-ink-300">{s.hint}</span>}
          </li>
        ))}
      </ul>
      <span className="sr-only">{`圖例 ${id}`}</span>
    </div>
  );
}

/// 橫向長條：類別多、名稱長的時候比直條好讀（名稱不用轉 45 度）。
export function BarList({ rows, unit = "", max }: { rows: { label: string; value: number; hint?: string }[]; unit?: string; max?: number }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate text-ink-200">{r.label}</span>
            <b className="tnum shrink-0 font-medium text-ink-50">
              {r.value.toLocaleString("zh-TW", { maximumFractionDigits: 3 })}{unit}
            </b>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-sm bg-ink-600">
            <div
              className="h-full rounded-sm"
              style={{ width: `${(r.value / top) * 100}%`, background: "var(--color-cat-1)" }}
            />
          </div>
          {r.hint && <div className="mt-0.5 text-xs text-ink-300">{r.hint}</div>}
        </li>
      ))}
      {rows.length === 0 && <li className="text-sm text-ink-300">沒有資料。</li>}
    </ul>
  );
}

export type Point = { t: number; v: number };

/// 面積折線：一條線、一個 y 軸。附十字準星讀數，不必 hover 也看得到最後一點。
export function AreaChart({
  points, height = 180, format = (v: number) => v.toLocaleString("zh-TW", { maximumFractionDigits: 0 }), label = "",
}: { points: Point[]; height?: number; format?: (v: number) => string; label?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/:/g, "");
  const W = 640;
  const padL = 8, padR = 56, padT = 10, padB = 22;
  const plotH = height - padT - padB;

  if (points.length === 0) {
    return <div className="flex h-[180px] items-center justify-center text-sm text-ink-300">尚無資料</div>;
  }

  const vs = points.map((p) => p.v);
  let min = Math.min(...vs), max = Math.max(...vs);
  if (max === min) { max = max === 0 ? 1 : max * 1.05; min = min === 0 ? 0 : min * 0.95; }
  const span = max - min;
  min -= span * 0.1; max += span * 0.1;

  const innerW = W - padL - padR;
  const x = (i: number) => padL + (points.length === 1 ? innerW / 2 : (innerW * i) / (points.length - 1));
  const y = (v: number) => padT + plotH - ((v - min) / (max - min)) * plotH;

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)} ${padT + plotH} L${x(0).toFixed(1)} ${padT + plotH} Z`;
  const ticks = [min + (max - min) * 0.1, (min + max) / 2, max - (max - min) * 0.1];
  const shown = hover != null ? points[hover] : points[points.length - 1];

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-4 text-xs text-ink-300">
        <span>{new Date(shown.t * 1000).toLocaleDateString("zh-TW")}</span>
        <b className="tnum text-sm font-medium text-ink-50">{format(shown.v)}</b>
        {label && <span>{label}</span>}
      </div>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="block w-full touch-none"
        role="img"
        aria-label={label || "走勢"}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const rx = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(((rx - padL) / innerW) * (points.length - 1));
          setHover(i >= 0 && i < points.length ? i : null);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`g-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-cat-1)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--color-cat-1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="stroke-ink-500" strokeWidth={1} />
            <text x={W - padR + 6} y={y(t) + 4} fontSize={11} className="tnum fill-ink-300">{format(t)}</text>
          </g>
        ))}
        <path d={area} fill={`url(#g-${gid})`} />
        <path d={line} fill="none" stroke="var(--color-cat-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} className="stroke-ink-300" strokeWidth={1} strokeOpacity={0.6} />
            <circle cx={x(hover)} cy={y(points[hover].v)} r={4.5} fill="var(--color-cat-1)" className="stroke-ink-700" strokeWidth={2} />
          </>
        )}
        <circle cx={x(points.length - 1)} cy={y(points[points.length - 1].v)} r={4} fill="var(--color-cat-1)" className="stroke-ink-700" strokeWidth={2} />
        <text x={padL} y={height - 6} fontSize={11} className="fill-ink-300">
          {new Date(points[0].t * 1000).toLocaleDateString("zh-TW")}
        </text>
        <text x={W - padR} y={height - 6} fontSize={11} textAnchor="end" className="fill-ink-300">
          {new Date(points[points.length - 1].t * 1000).toLocaleDateString("zh-TW")}
        </text>
      </svg>
    </div>
  );
}
