"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildDots, lonLatToUnit, rotate, TRACKED, type Camera, type Dot } from "@/lib/globe";

export type GlobeCountry = {
  country: string;
  name: string;
  enabled: boolean;
  lat: number;
  lon: number;
  /// 目前選的那一個量（核發／交易／掛單），單位公斤。
  /// 地球一次只畫一個量：兩個量疊在同一顆球上，就得用兩種比例尺，
  /// 而讀者沒有辦法從一根柱子判斷它用的是哪一把尺。要比另一個量就換一個量。
  value: number;
};

type Props = {
  countries: GlobeCountry[];
  selected: string | null;
  onSelect: (code: string | null) => void;
  /// 目前畫的是哪一個量，用在 tooltip 的文字上。
  measureLabel: string;
  className?: string;
};

/// 讀 CSS 變數。地球跟著三段式主題切換走，不自己記一份顏色——
/// 顏色只該有一個來源，否則改了 globals.css 地球不會跟著變。
function readPalette(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const v = (n: string, fallback: string) => cs.getPropertyValue(n).trim() || fallback;
  return {
    ocean: v("--globe-ocean", "#0d1317"),
    land: v("--globe-land", "#3a444e"),
    tide: v("--color-tide", "#29c1e1"),
    muted: v("--color-ink-300", "#8b8e91"),
    ink: v("--color-ink-50", "#f2f2f2"),
    panel: v("--color-ink-700", "#1e2329"),
    border: v("--color-ink-500", "#2a3139"),
  };
}

/// #rrggbb → rgba(...)，alpha 自己給。畫布上每個點的透明度都不一樣（depth cue），
/// 所以顏色必須能帶 alpha，而 CSS 變數存的是不透明的 hex。
/// 這個顏色算亮還是暗？用來決定幾個只跟明暗有關、跟色相無關的參數
/// （背面點的透明度、亮面的強度）。比起把主題名稱傳進畫布，
/// 從顏色本身判斷更可靠——使用者換了 CSS 變數，這裡自動跟上。
function isLight(hex: string) {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const i = parseInt(n, 16);
  // ITU-R BT.601 亮度
  return (0.299 * ((i >> 16) & 255) + 0.587 * ((i >> 8) & 255) + 0.114 * (i & 255)) / 255 > 0.5;
}

function withAlpha(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const int = parseInt(n, 16);
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${a})`;
}

/// 在球上直接標一個名字與數值。標籤朝球心的反方向外推，
/// 免得壓在地球上；靠右半邊就向右展開，靠左半邊就向左，兩邊都不會被球擋住。
function label(
  ctx: CanvasRenderingContext2D,
  pal: { ink: string; panel: string; border: string },
  x: number, y: number, rx: number,
  name: string, value: number,
) {
  const right = rx >= 0;
  const text = value > 0
    ? `${name}　${(value / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 0 })} 噸`
    : name;
  ctx.font = "500 12px ui-sans-serif, system-ui, sans-serif";
  const w = ctx.measureText(text).width;
  const pad = 7;
  const gap = 10;
  const bx = right ? x + gap : x - gap - (w + pad * 2);
  const by = y - 11;

  ctx.beginPath();
  // roundRect 在比較舊的瀏覽器上沒有。這段跑在 requestAnimationFrame 裡，
  // 丟出例外會讓整個迴圈停掉、地球從此不動——退回直角矩形，難看勝過不會動。
  if (typeof ctx.roundRect === "function") ctx.roundRect(bx, by, w + pad * 2, 22, 6);
  else ctx.rect(bx, by, w + pad * 2, 22);
  ctx.fillStyle = withAlpha(pal.panel, 0.92);
  ctx.fill();
  ctx.strokeStyle = withAlpha(pal.border, 1);
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(right ? bx : bx + w + pad * 2, y);
  ctx.strokeStyle = withAlpha(pal.border, 1);
  ctx.stroke();

  ctx.fillStyle = pal.ink;
  ctx.textBaseline = "middle";
  ctx.fillText(text, bx + pad, by + 11);
}

const TILT = -0.32; // 北半球稍微轉向鏡頭：亞太在上半部，看起來才像地球不像圓盤
const AUTO_SPEED = 0.055; // 弧度/秒。一圈約兩分鐘，夠慢到不會讓人分心

export default function Globe({ countries, selected, onSelect, measureLabel, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dots, setDots] = useState<Dot[] | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; code: string } | null>(null);

  // 相機、拖曳與自轉都放在 ref 裡：它們每一幀都在變，放進 state 會讓 React
  // 每秒重繪六十次。畫布的內容不是 React 管的，只有 tooltip 才需要 state。
  const cam = useRef<Camera>({ yaw: -2.0, pitch: TILT });
  const drag = useRef<{ on: boolean; x: number; y: number; moved: boolean }>({ on: false, x: 0, y: 0, moved: false });
  const spin = useRef(true);
  const target = useRef<number | null>(null);

  const byCode = useMemo(() => new Map(countries.map((c) => [c.country, c])), [countries]);
  const maxValue = useMemo(() => Math.max(1, ...countries.map((c) => c.value)), [countries]);

  useEffect(() => {
    let alive = true;
    buildDots().then((d) => alive && setDots(d)).catch(() => {});
    return () => { alive = false; };
  }, []);

  // 從清單選了一個國家，地球轉過去。不是瞬移——轉過去的過程本身就說明了它在哪裡。
  useEffect(() => {
    if (!selected) return;
    const c = byCode.get(selected);
    if (!c) return;
    const want = -(c.lon * Math.PI) / 180;
    const cur = cam.current.yaw;
    // 選最近的一圈，不要為了轉 10 度而繞 350 度
    target.current = want + Math.round((cur - want) / (2 * Math.PI)) * 2 * Math.PI;
  }, [selected, byCode]);

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number, pal: ReturnType<typeof readPalette>) => {
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.42;
      const c = cam.current;
      const light = isLight(pal.ocean);

      // 大氣層：球體外緣一圈很淡的光。少了這一層，球看起來像貼在背景上的貼紙。
      const glow = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.18);
      glow.addColorStop(0, withAlpha(pal.tide, light ? 0.1 : 0.16));
      glow.addColorStop(1, withAlpha(pal.tide, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.18, 0, Math.PI * 2);
      ctx.fill();

      // 海：先鋪滿，再疊上明暗。
      //
      // 一開始是用「中心不透明、邊緣半透明」做出邊緣轉暗——那在深色模式成立，
      // 在淺色模式剛好反過來：邊緣透出比海更亮的頁面底色，球看起來是凸的還是凹的
      // 全看背景，這不是照明，是漏色。所以改成疊一層獨立的明暗，
      // 亮面在左上、邊緣壓暗，兩種配色下都是同一顆被同一個方向照亮的球。
      ctx.fillStyle = pal.ocean;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();

      const limb = ctx.createRadialGradient(cx, cy, R * 0.5, cx, cy, R);
      limb.addColorStop(0, "rgba(0,0,0,0)");
      limb.addColorStop(1, light ? "rgba(22,40,58,0.22)" : "rgba(0,0,0,0.45)");
      ctx.fillStyle = limb;
      ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

      const lit = ctx.createRadialGradient(cx - R * 0.38, cy - R * 0.42, 0, cx - R * 0.38, cy - R * 0.42, R * 1.05);
      lit.addColorStop(0, `rgba(255,255,255,${light ? 0.5 : 0.07})`);
      lit.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = lit;
      ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
      ctx.restore();

      // 球緣描一圈細線。淺色模式下海色跟頁面底色只差一點，
      // 沒有這條線，地球會變成一片漂在背景上的點，看不出是一顆球。
      ctx.strokeStyle = withAlpha(pal.land, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R - 0.5, 0, Math.PI * 2);
      ctx.stroke();

      if (!dots) return;

      const dotR = Math.max(0.9, R / 190);
      const back: Dot[] = [];
      const front: Dot[] = [];
      for (const d of dots) (rotate(d, c).z > 0 ? front : back).push(d);

      // 背面的點用很低的透明度畫出來。這是這顆地球跟一張圓形貼圖的差別：
      // 你看得見地球背面的輪廓在轉，於是它是一顆球，不是一個圓。
      for (const pass of [back, front]) {
        const isBack = pass === back;
        for (const d of pass) {
          const r = rotate(d, c);
          const x = cx + r.x * R;
          const y = cy - r.y * R;
          const depth = isBack ? -r.z : r.z;
          const cc = d.region >= 0 ? byCode.get(TRACKED[d.region]) : undefined;
          const on = cc?.enabled;
          const isSel = cc && (cc.country === selected || cc.country === hover);
          const base = d.region < 0 ? pal.land : on ? pal.tide : pal.muted;
          const alpha = isBack
            ? (light ? 0.05 : 0.09) * (0.4 + 0.6 * depth)
            : (d.region < 0 ? 0.78 : on ? 0.95 : 0.55) * (0.45 + 0.55 * depth);
          const size = dotR * (isBack ? 0.75 : 0.6 + 0.4 * depth) * (isSel ? 1.7 : 1);
          ctx.fillStyle = withAlpha(isSel ? pal.tide : base, isSel ? Math.min(1, alpha * 1.6) : alpha);
          ctx.beginPath();
          ctx.arc(x, y, size, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 柱子：高度＝目前選的那個量。球面上的長度會被透視與曲率壓縮——
      // 靠近邊緣的柱子一定看起來比正對鏡頭的短——所以柱子只回答「在哪裡、大概多少」，
      // 精確的比較留給旁邊清單裡的水平長條，那裡沒有曲面。
      const marks = countries
        .map((k) => ({ k, r: rotate(lonLatToUnit(k.lon, k.lat), c) }))
        .sort((a, b) => a.r.z - b.r.z);

      for (const { k, r } of marks) {
        if (r.z < -0.08) continue; // 轉到背面就不畫，免得柱子穿過地球
        const fade = Math.min(1, Math.max(0, (r.z + 0.08) / 0.3));
        const x0 = cx + r.x * R;
        const y0 = cy - r.y * R;
        const isSel = k.country === selected || k.country === hover;

        // 選中的那一國給一圈光暈。這是「你現在看的是這一個」的訊號，不是數值——
        // 光暈的大小如果也拿來表示某個量，同一個記號就背了兩個意思。
        if (isSel) {
          const rr = 26 * (0.6 + 0.4 * Math.max(0, r.z));
          const g = ctx.createRadialGradient(x0, y0, 0, x0, y0, rr);
          g.addColorStop(0, withAlpha(pal.tide, 0.38 * fade));
          g.addColorStop(1, withAlpha(pal.tide, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x0, y0, rr, 0, Math.PI * 2);
          ctx.fill();
        }

        if (k.value > 0) {
          // 平方根而不是線性：柱子的視覺量感跟長度不成正比（近大遠小、又有曲率），
          // 開平方之後最大與最小的差距壓在看得完的範圍內，排序仍然完全保留。
          const hgt = 0.06 + 0.3 * Math.sqrt(k.value / maxValue);
          const x1 = cx + r.x * R * (1 + hgt);
          const y1 = cy - r.y * R * (1 + hgt);
          ctx.strokeStyle = withAlpha(pal.tide, (isSel ? 1 : 0.85) * fade);
          ctx.lineWidth = isSel ? 3 : 2;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
          ctx.fillStyle = withAlpha(pal.tide, fade);
          ctx.beginPath();
          ctx.arc(x1, y1, isSel ? 3.6 : 2.6, 0, Math.PI * 2);
          ctx.fill();

          // 只有選中的那一國在球上直接標數字。每一國都標會糊成一片，
          // 而標一個就等於回答了「我現在看的是誰、多少」，不必再回頭看清單。
          if (k.country === selected) label(ctx, pal, x1, y1, r.x, k.name, k.value);
        } else {
          // 這個量是零的轄區只留一個空心點：它在地球上有位置，但沒有量。
          // 畫一根零高度的柱子會看起來像資料掉了。
          ctx.strokeStyle = withAlpha(isSel ? pal.tide : pal.muted, 0.9 * fade);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x0, y0, isSel ? 5 : 3.5, 0, Math.PI * 2);
          ctx.stroke();
          if (k.country === selected) label(ctx, pal, x0, y0, r.x, k.name, 0);
        }
      }
    },
    [dots, countries, byCode, selected, hover, maxValue],
  );

  useEffect(() => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    let pal = readPalette(wrap);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let w = 0, h = 0;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rect = wrap.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    // 主題換了就重讀顏色。data-theme 在 <html> 上，system 模式則沒有這個屬性，
    // 所以還要聽作業系統的偏好。
    const repal = () => { pal = readPalette(wrap); };
    const mo = new MutationObserver(repal);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", repal);

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = target.current;
      if (t !== null) {
        // 轉到選定的國家。用指數逼近，最後幾度慢下來，不會硬生生煞住。
        const d = t - cam.current.yaw;
        if (Math.abs(d) < 0.002) { cam.current.yaw = t; target.current = null; }
        else cam.current.yaw += d * Math.min(1, dt * 4);
      } else if (spin.current && !drag.current.on && !reduce.matches) {
        cam.current.yaw += AUTO_SPEED * dt;
      }
      draw(ctx, w, h, pal);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      scheme.removeEventListener("change", repal);
    };
  }, [draw]);

  /// 命中測試：把每個轄區的錨點投影回畫布，取最近的一個。
  const hit = useCallback(
    (px: number, py: number): string | null => {
      const wrap = wrapRef.current;
      if (!wrap) return null;
      const rect = wrap.getBoundingClientRect();
      const cx = rect.width / 2, cy = rect.height / 2;
      const R = Math.min(rect.width, rect.height) * 0.42;
      let best: string | null = null;
      let bestD = 26 * 26;
      for (const k of countries) {
        const r = rotate(lonLatToUnit(k.lon, k.lat), cam.current);
        if (r.z < 0) continue;
        const dx = px - (cx + r.x * R);
        const dy = py - (cy - r.y * R);
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = k.country; }
      }
      return best;
    },
    [countries],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { on: true, x: e.clientX, y: e.clientY, moved: false };
    target.current = null;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (drag.current.on) {
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
      cam.current.yaw += dx * 0.006;
      cam.current.pitch = Math.max(-1.2, Math.min(1.2, cam.current.pitch + dy * 0.004));
      drag.current.x = e.clientX;
      drag.current.y = e.clientY;
      return;
    }
    const k = hit(px, py);
    setHover(k);
    setTip(k ? { x: px, y: py, code: k } : null);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const wasDrag = drag.current.moved;
    drag.current.on = false;
    if (wasDrag) return;
    const rect = wrapRef.current!.getBoundingClientRect();
    const k = hit(e.clientX - rect.left, e.clientY - rect.top);
    onSelect(k === selected ? null : k);
  };

  const tipCountry = tip ? byCode.get(tip.code) : null;

  return (
    <div
      ref={wrapRef}
      className={`relative touch-none select-none ${className ?? ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => { drag.current.on = false; setHover(null); setTip(null); }}
    >
      {/* 畫布對輔助技術隱藏：地球是同一份資料的視覺版本，
          鍵盤與螢幕報讀器走旁邊那份清單，那裡每一國都是一個真的按鈕。 */}
      <canvas ref={canvasRef} aria-hidden className="h-full w-full cursor-grab active:cursor-grabbing" />
      {tipCountry && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+12px)] whitespace-nowrap rounded-ctl border border-ink-500 bg-ink-700/95 px-2.5 py-1.5 text-xs shadow-lg backdrop-blur"
          style={{ left: tip!.x, top: tip!.y }}
        >
          <div className="font-medium text-ink-50">{tipCountry.name}</div>
          <div className="text-ink-300">
            {tipCountry.value > 0
              ? `${measureLabel} ${(tipCountry.value / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 0 })} 噸`
              : tipCountry.enabled ? `尚無${measureLabel}` : "未開放"}
          </div>
        </div>
      )}
    </div>
  );
}
