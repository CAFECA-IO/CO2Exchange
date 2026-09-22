"use client";
import { useId, useMemo, useState } from "react";

/// 一個轄區的價格走勢——小圖，回答「在漲還是在跌、波動大不大」，
/// 不回答「三月十七號多少錢」。後者去 /about 的 K 線，那裡有完整的軸與明細表。
///
/// 這決定了它長什麼樣：沒有格線、沒有軸、沒有圖例（只有一條線，卡片標題已經
/// 說了畫的是什麼）。只直接標三個數字——最高、最低、最新——其餘留給互動。
///
/// 面積用漸層而不是單一淡色：一條線加一片均勻的色塊，讀起來像兩個東西；
/// 漸層由線往下淡出，視覺重量集中在線上，色塊只負責指出「下面是同一件事」。
/// 深淺兩色各給一組不透明度（`--spark-top`），不是把同一個值翻過來用——
/// 同樣 30% 的青色畫在近黑上是一層薄霧，畫在白上是一塊顏色。

export type SparkPoint = { t: number; price: number };

type Props = {
  points: SparkPoint[];
  /// 無障礙用的一句話，說明這張圖畫的是誰的價格
  label: string;
  height?: number;
};

const W = 300; // viewBox 寬；SVG 用 preserveAspectRatio="none" 橫向撐滿
const money = (v: number) => v.toLocaleString("zh-TW", { maximumFractionDigits: 0 });
const day = (t: number) =>
  new Date(t * 1000).toLocaleDateString("zh-TW", { year: "numeric", month: "numeric", day: "numeric" });

export function PriceSpark({ points, label, height = 64 }: Props) {
  const gid = useId();
  const [hover, setHover] = useState<number | null>(null);

  const g = useMemo(() => {
    if (points.length < 2) return null;
    const H = height;
    const pad = 6; // 上下留白，讓線不貼邊、端點的圓環畫得下
    const t0 = points[0].t;
    const span = Math.max(1, points[points.length - 1].t - t0);
    const lo = Math.min(...points.map((p) => p.price));
    const hi = Math.max(...points.map((p) => p.price));
    // 價格帶很窄時（各國通常如此），純靠 min/max 撐滿會把 1% 的波動畫成
    // 滿格的山巒——看起來像劇烈震盪。給一個最小跨度，平的就讓它看起來平。
    const mid = (hi + lo) / 2;
    const half = Math.max((hi - lo) / 2, mid * 0.06);
    const top = mid + half, bottom = mid - half;
    const x = (t: number) => ((t - t0) / span) * W;
    const y = (v: number) => pad + (1 - (v - bottom) / (top - bottom || 1)) * (H - pad * 2);
    const xy = points.map((p) => ({ ...p, x: x(p.t), y: y(p.price) }));
    const line = xy.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    return {
      H, xy, line,
      area: `${line} L${W},${H} L0,${H} Z`,
      last: xy[xy.length - 1],
      max: xy.reduce((a, b) => (b.price > a.price ? b : a)),
      min: xy.reduce((a, b) => (b.price < a.price ? b : a)),
    };
  }, [points, height]);

  if (!g) {
    return (
      <p className="rounded-ctl border border-dashed border-ink-500 px-3 py-4 text-center text-xs text-ink-300">
        成交筆數還不夠畫出走勢
      </p>
    );
  }

  const shown = hover != null ? g.xy[hover] : g.last;
  const change = g.last.price / g.xy[0].price - 1;

  return (
    <figure className="space-y-1">
      {/* 讀數在圖的上面，不是只在 tooltip 裡：沒有滑鼠、或根本不去 hover 的人
          也看得到最新價與區間漲跌。hover 時這一行才換成那一點的值。 */}
      <figcaption className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-ink-300">{hover != null ? day(shown.t) : "近一年走勢"}</span>
        <span className="tabular-nums text-ink-50">
          <span className="font-mono">{money(shown.price)}</span>
          <span className="ml-0.5 text-[10px] text-ink-300">mTWD / 噸</span>
          {hover == null && (
            <span className={`ml-2 font-mono ${change >= 0 ? "text-up" : "text-down"}`}>
              {change >= 0 ? "+" : ""}{(change * 100).toFixed(1)}%
            </span>
          )}
        </span>
      </figcaption>

      <svg
        viewBox={`0 0 ${W} ${g.H}`}
        preserveAspectRatio="none"
        style={{ height: g.H }}
        className="w-full touch-none"
        role="img"
        aria-label={`${label}：近一年成交均價走勢，起 ${money(g.xy[0].price)}、最高 ${money(g.max.price)}、最低 ${money(g.min.price)}、最新 ${money(g.last.price)} mTWD / 噸`}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          // 取最接近的點，不是「剛好壓在線上」——小圖上要求精準命中等於不能用
          let best = 0;
          for (let i = 1; i < g.xy.length; i++) {
            if (Math.abs(g.xy[i].x - px) < Math.abs(g.xy[best].x - px)) best = i;
          }
          setHover(best);
        }}
      >
        <defs>
          <linearGradient id={`${gid}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-tide)" stopOpacity="var(--spark-top, 0.3)" />
            <stop offset="100%" stopColor="var(--color-tide)" stopOpacity="0" />
          </linearGradient>
        </defs>

        <path d={g.area} fill={`url(#${gid}-fill)`} />
        <path
          d={g.line}
          fill="none"
          stroke="var(--color-tide)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          // viewBox 被橫向拉伸，線寬會跟著變形；這一行讓筆畫維持 2px
          vectorEffect="non-scaling-stroke"
        />

        {hover != null && (
          <line
            x1={shown.x} x2={shown.x} y1={0} y2={g.H}
            stroke="var(--color-ink-300)" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.5}
          />
        )}
        {/* 端點：先畫一圈底色當作「留白的環」，線穿過去時仍然看得出是一個點 */}
        <circle cx={shown.x} cy={shown.y} r={5.5} fill="var(--color-ink-700)" />
        <circle cx={shown.x} cy={shown.y} r={3.5} fill="var(--color-tide)" />
      </svg>

      {/* 最高與最低直接標出來，不必靠 hover 才讀得到。 */}
      <div className="flex justify-between text-[10px] text-ink-300">
        <span className="tabular-nums">最低 <span className="font-mono">{money(g.min.price)}</span></span>
        <span className="tabular-nums">最高 <span className="font-mono">{money(g.max.price)}</span></span>
      </div>
    </figure>
  );
}
