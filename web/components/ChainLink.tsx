import { explorerUrl, type ExplorerKind } from "@/lib/explorer";

/// 鏈上的交易、區塊或地址：有瀏覽器就連過去（新分頁），沒有（本機 anvil、EXPLORER_URL=none）就只顯示文字。
/// `base` 來自 /api/config 的 `explorer`。只給真的上鏈的東西用，帳本事件雜湊不要包它（見 lib/explorer.ts）。
export function ChainLink({ base, kind, value, children, className = "", title }: {
  base: string | null | undefined;
  kind: ExplorerKind;
  value: string | number | bigint | null | undefined;
  children?: React.ReactNode;
  className?: string;
  title?: string;
}) {
  const href = explorerUrl(base, kind, value);
  const label = children ?? String(value ?? "—");
  const what = kind === "tx" ? "交易" : kind === "block" ? "區塊" : "地址";
  if (!href) return <span className={className} title={title}>{label}</span>;
  return (
    <a
      className={`${className} underline decoration-dotted underline-offset-2 hover:text-tide`}
      href={href} target="_blank" rel="noreferrer"
      title={title ?? `在區塊鏈瀏覽器上看這筆${what}`}
      data-explorer={kind}
    >
      {label}
    </a>
  );
}
