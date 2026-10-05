/// 區塊鏈瀏覽器的連結：審計頁、後台入出金把鏈上交易、區塊、合約地址連到瀏覽器上，讀者自己點進去看，不必相信本站。
///
/// 不依賴 Next，伺服器（/api/config）與前端都 import 這一份。
///
/// 只給**真的上鏈**的東西用：承諾交易、入出金確認、合約地址。公告欄與持有明細裡的 `txHash` 是**帳本事件雜湊**
///（帳本裡的動作沒有鏈上交易，見 lib/server/ledger/read.ts），連過去只會是「找不到交易」。
///
/// 路徑格式是 Boltchain 節點內建瀏覽器（`boltchain … --explorer`）的：`/tx/<hash>`、`/block/<number>`、`/address/<addr>`。
/// Etherscan、Blockscout 也是同一套路徑，換鏈時只要改 EXPLORER_URL。

/// 已知的瀏覽器。chainId 不在表上、也沒有設 EXPLORER_URL → 不給連結（anvil 沒有瀏覽器）
export const KNOWN_EXPLORERS: Record<number, string> = {
  8018: "https://boltchain.cafeca.io",
  // docker-compose.yml 的自架挖礦鏈：節點加了 --explorer，只綁本機（BOLTCHAIN_EXPLORER_PORT 預設 18080）
  18018: "http://127.0.0.1:18080",
};

/// EXPLORER_URL 設了就用它（`none` 或空字串＝不要連結），否則查上表。不是 http(s) 網址的一律當作沒有
export function explorerBase(chainId: number, override?: string | null): string | null {
  const raw = override !== undefined && override !== null ? override.trim() : KNOWN_EXPLORERS[chainId] ?? "";
  if (!raw || raw.toLowerCase() === "none") return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return u.toString().replace(/\/+$/, "");
}

export type ExplorerKind = "tx" | "block" | "address";

/// 格式不對的值不給連結：寧可沒有連結，也不要連到瀏覽器的錯誤頁
export function explorerUrl(base: string | null | undefined, kind: ExplorerKind, value: string | number | bigint | null | undefined): string | null {
  if (!base || value === null || value === undefined) return null;
  const v = String(value);
  const okFormat =
    kind === "tx" ? /^0x[0-9a-fA-F]{64}$/.test(v)
    : kind === "address" ? /^0x[0-9a-fA-F]{40}$/.test(v)
    : /^[0-9]+$/.test(v);
  if (!okFormat || (kind === "tx" && /^0x0+$/.test(v))) return null;
  return `${base}/${kind}/${v}`;
}
