"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Candle } from "@/lib/server/ticker";

/// 手繪 SVG K 線 + 成交量副圖。沒有引入任何圖表套件，配色與 TideBit-DeFi 一致。
///
/// 無障礙：漲跌的綠紅在 deuteranopia 下幾乎分不開（ΔE 4.2），所以這裡沿用
/// 傳統日本 K 線畫法——**漲為空心、跌為實心**。不看顏色，只看實心與否也讀得出方向。
/// 另外提供「明細」表格檢視，任何一根 K 棒的數值都不必靠 hover 才能取得。

type Props = {
  candles: Candle[];
  /** 參考線：政府碳費費率（每噸）。畫成一條水平線當經濟錨點。 */
  referencePrice?: number | null;
  referenceLabel?: string;
  height?: number;
};

const fmtPrice = (v: number) => (v / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 0 });
const fmtTime = (t: number) =>
  new Date(t * 1000).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function PriceChart({ candles, referencePrice, referenceLabel = "碳費費率", height = 320 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 量出容器實際寬度，讓 1 個 SVG 單位 = 1 CSS px。
  // 否則固定 viewBox 在窄螢幕會被等比縮到只剩一小條，上下空一大片。
  const [W, setW] = useState(1000);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const volH = 56;
  const padL = 8;
  const padR = W < 520 ? 44 : 64; // 右側留給價格軸
  const padT = 12;
  const padB = 26; // 底部留給時間軸，避免軸標被裁掉
  const plotH = height - volH - padT - padB - 8;

  const geom = useMemo(() => {
    if (candles.length === 0) return null;
    const lows = candles.map((c) => c.l);
    const highs = candles.map((c) => c.h);
    let min = Math.min(...lows);
    let max = Math.max(...highs);
    // 參考線只有落在資料範圍附近時才納入座標軸。碳費費率常常遠低於市場價，
    // 硬要塞進來會把 K 線壓成一條扁線 —— 那種情況改在統計列呈現數字就好。
    const spread = max - min || max || 1;
    const refInScale = referencePrice != null && referencePrice > min - spread && referencePrice < max + spread;
    if (refInScale) {
      min = Math.min(min, referencePrice!);
      max = Math.max(max, referencePrice!);
    }
    if (max === min) {
      // 只有一個價位時給一點上下空間，K 線才不會壓成一條線
      max = max * 1.02 || 1;
      min = min * 0.98;
    }
    const span = max - min;
    min -= span * 0.08;
    max += span * 0.08;

    const innerW = W - padL - padR;
    const step = innerW / candles.length;
    const bodyW = Math.max(2, Math.min(14, step * 0.6));
    const x = (i: number) => padL + step * (i + 0.5);
    const y = (p: number) => padT + plotH - ((p - min) / (max - min)) * plotH;

    const maxVol = Math.max(...candles.map((c) => c.v), 1);
    const vy = (v: number) => (v / maxVol) * volH;

    // 價格軸刻度：四等分
    const ticks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4);
    return { min, max, step, bodyW, x, y, vy, ticks, innerW, refInScale };
  }, [candles, referencePrice, plotH, W, padR]);

  if (candles.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-[--radius-card] border border-ink-500 bg-ink-700 text-sm text-ink-300" style={{ height }}>
        這段期間沒有成交紀錄
      </div>
    );
  }
  const g = geom!;
  const active = hover != null ? candles[hover] : null;
  const shown = active ?? candles[candles.length - 1];
  const shownUp = shown.c >= shown.o;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const rx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.floor((rx - padL) / g.step);
    setHover(i >= 0 && i < candles.length ? i : null);
  }

  return (
    <div ref={wrapRef} className="rounded-[--radius-card] border border-ink-500 bg-ink-700">
      {/* 讀數列：hover 時顯示該根 K 棒，沒 hover 時顯示最新 */}
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 border-b border-ink-500 px-4 py-2 text-xs">
        <span className="text-ink-300">{fmtTime(shown.t)}</span>
        {([["開", shown.o], ["高", shown.h], ["低", shown.l], ["收", shown.c]] as const).map(([k, v]) => (
          <span key={k} className="text-ink-300">
            {k}
            <b className={`tnum ml-1 font-medium ${shownUp ? "text-up" : "text-down"}`}>{fmtPrice(v)}</b>
          </span>
        ))}
        <span className="text-ink-300">
          量<b className="tnum ml-1 font-medium text-ink-50">{(shown.v / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 噸</b>
        </span>
        <button
          onClick={() => setTable((t) => !t)}
          className="ml-auto rounded border border-ink-500 px-2 py-0.5 text-ink-300 transition hover:border-tide/60 hover:text-ink-50"
          aria-pressed={table}
        >
          {table ? "看走勢圖" : "看明細表"}
        </button>
      </div>

      {table ? (
        <div className="max-h-[320px] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-ink-600 text-left text-ink-300">
              <tr>
                <th className="px-4 py-2 font-medium">時間</th>
                <th className="px-3 py-2 text-right font-medium">開</th>
                <th className="px-3 py-2 text-right font-medium">高</th>
                <th className="px-3 py-2 text-right font-medium">低</th>
                <th className="px-3 py-2 text-right font-medium">收</th>
                <th className="px-4 py-2 text-right font-medium">量（噸）</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-500">
              {[...candles].reverse().map((c) => (
                <tr key={c.t} className="text-ink-200">
                  <td className="px-4 py-1.5 whitespace-nowrap">{fmtTime(c.t)}</td>
                  <td className="tnum px-3 py-1.5 text-right">{fmtPrice(c.o)}</td>
                  <td className="tnum px-3 py-1.5 text-right">{fmtPrice(c.h)}</td>
                  <td className="tnum px-3 py-1.5 text-right">{fmtPrice(c.l)}</td>
                  <td className={`tnum px-3 py-1.5 text-right ${c.c >= c.o ? "text-up" : "text-down"}`}>{fmtPrice(c.c)}</td>
                  <td className="tnum px-4 py-1.5 text-right">{(c.v / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 2 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${height}`}
          width={W}
          height={height}
          className="block touch-none"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label="減量額度成交價走勢 K 線圖"
        >
          {/* 格線：實線細髮絲，比表面亮一階 */}
          {g.ticks.map((p) => (
            <g key={p}>
              <line x1={padL} x2={W - padR} y1={g.y(p)} y2={g.y(p)} className="stroke-ink-500" strokeWidth={1} />
              <text x={W - padR + 6} y={g.y(p) + 4} fontSize={11} className="tnum fill-ink-300">
                {fmtPrice(p)}
              </text>
            </g>
          ))}

          {/* 碳費參考線：位置本身就是資訊，不靠顏色 */}
          {referencePrice != null && g.refInScale && (
            <g>
              <line x1={padL} x2={W - padR} y1={g.y(referencePrice)} y2={g.y(referencePrice)} className="stroke-warn" strokeWidth={1} strokeOpacity={0.8} />
              <text x={padL + 4} y={g.y(referencePrice) - 5} fontSize={11} className="fill-warn">
                {referenceLabel} {fmtPrice(referencePrice)}
              </text>
            </g>
          )}

          {/* K 棒：漲=空心、跌=實心 */}
          {candles.map((c, i) => {
            const up = c.c >= c.o;
            const stroke = up ? "stroke-up" : "stroke-down";
            const fill = up ? "fill-up" : "fill-down";
            const bodyTop = g.y(Math.max(c.o, c.c));
            const bodyBot = g.y(Math.min(c.o, c.c));
            const h = Math.max(1, bodyBot - bodyTop);
            return (
              <g key={c.t} opacity={hover == null || hover === i ? 1 : 0.55}>
                <line x1={g.x(i)} x2={g.x(i)} y1={g.y(c.h)} y2={g.y(c.l)} className={stroke} strokeWidth={1} />
                <rect
                  x={g.x(i) - g.bodyW / 2}
                  y={bodyTop}
                  width={g.bodyW}
                  height={h}
                  className={`${stroke} ${up ? "fill-none" : fill}`}
                  strokeWidth={1.5}
                />
                {/* 成交量副圖，共用 x 軸（不是雙 y 軸） */}
                <rect
                  x={g.x(i) - g.bodyW / 2}
                  y={height - padB - g.vy(c.v)}
                  width={g.bodyW}
                  height={g.vy(c.v)}
                  className={fill}
                  fillOpacity={up ? 0.35 : 0.55}
                />
              </g>
            );
          })}

          {/* 十字準星：讀者瞄的是時間，不是 2px 的線 */}
          {hover != null && (
            <line x1={g.x(hover)} x2={g.x(hover)} y1={padT} y2={height - padB} className="stroke-ink-300" strokeWidth={1} strokeOpacity={0.6} />
          )}

          {/* 時間軸：首、中、末三個標籤就夠，不需要每根都標 */}
          {(W < 520 ? [0, candles.length - 1] : [0, Math.floor(candles.length / 2), candles.length - 1])
            .filter((i, idx, a) => a.indexOf(i) === idx && i >= 0)
            .map((i, idx, a) => {
              // 首尾兩個標籤靠邊對齊，否則置中的文字會被容器裁掉
              const first = idx === 0;
              const last = idx === a.length - 1;
              const anchor = first ? "start" : last ? "end" : "middle";
              const x = first ? padL : last ? W - padR : g.x(i);
              return (
                <text key={i} x={x} y={height - 8} fontSize={11} textAnchor={anchor} className="fill-ink-300">
                  {fmtTime(candles[i].t)}
                </text>
              );
            })}
        </svg>
      )}
    </div>
  );
}
