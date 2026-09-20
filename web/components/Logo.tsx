/**
 * TideBit-DeFi 的標誌。
 *
 * 原始檔（TideBit-DeFi/public/elements/nav_logo.svg）的六角形外框與「Tide」字樣是
 * 寫死的白色，那是因為母站只有深色一種佈景。本站有淺色模式，白色放上去會整個消失，
 * 所以這裡把「該用白色的部分」改成 currentColor——顏色交給外層的文字色決定，
 * 深色底是接近白的 ink-50，淺色底就自動變成深墨色。青綠漸層（品牌色）維持原樣，
 * 那是識別本身，不該跟著佈景變。
 *
 * 完整字標（含「TideBit」字樣）留在 public/tidebit-wordmark.svg，供印刷與簡報使用；
 * 站上只用標記，品牌名由文字排版，這樣「-DeFi 碳權交易所」才能跟標記排在同一行。
 */

const GRAD_FROM = "#29c1e1";
const GRAD_TO = "#1ae2a0";

/// 六角形外框（currentColor）＋ 內部單體（品牌漸層）
const HEX = "M-551.009,972.233h-25.664l-12.831-22.25,12.831-22.25h25.664l12.831,22.25Zm-23.96-2.949h22.257l11.13-19.3-11.13-19.3h-22.257l-11.13,19.3Z";
const MONOGRAM = "M-532.382,977.966l6.073-10.632H-547.8l-10.743,18.607h7.085l7.2-12.471h7.436l-13.32,23.1h20.171l10.743-18.607Zm-1.128,12.471h-6.063l3.653-6.335h6.068Z";

function Grad({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={id} y1="0.5" x2="1" y2="0.5" gradientUnits="objectBoundingBox">
        <stop offset="0" stopColor={GRAD_FROM} />
        <stop offset="1" stopColor={GRAD_TO} />
      </linearGradient>
    </defs>
  );
}

/// 只有標記（六角形＋單體）。用在導覽列、favicon 之外的小尺寸場合。
export function LogoMark({ className = "h-7 w-auto" }: { className?: string }) {
  const id = "tb-mark-grad";
  return (
    <svg viewBox="0 0 51.33 44.5" className={className} role="img" aria-label="TideBit-DeFi">
      <Grad id={id} />
      {/* 標記單獨用的時候不套外層位移：原始檔的外層 <g> 是為了讓字標對齊，
          標記自己的 transform 已經把座標帶到 0,0 附近了。 */}
      <path d={HEX} transform="translate(589.504 -927.733)" fill="currentColor" />
      <path d={MONOGRAM} transform="translate(565.097 -958.946)" fill={`url(#${id})`} />
    </svg>
  );
}
