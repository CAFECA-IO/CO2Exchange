import fs from "node:fs";
import path from "node:path";
import { replacer, reviver } from "./events.ts";

/// 鏈上事件的增量索引：讀過的區塊段記在磁碟上，下一次只讀新的區塊。
///
/// 為什麼需要它：網站、每小時的承諾工具、營運工具都要讀同幾種事件（承諾、授權清單、入出金確認、
/// CAFECA 的金鑰事件），原本每一次都從部署區塊讀到最新。Boltchain 每 6 秒一塊、`eth_getLogs` 一次
/// 最多 10,000 塊——一年後每讀一種事件就要打五百多次 RPC，而且每小時要讀好幾種。
///
/// 規則：
///   · **只把「夠深」的區塊段寫進檔案**（比最新區塊舊 `confirmations` 塊以上）。更新的那一段每次都重讀，
///     不寫檔——分叉或節點回報不一致時，最多影響那幾塊，下一次自然更正。
///   · 檔案帶一把鍵（鏈、合約、部署時間、事件種類、起點區塊）。對不上就整份重讀，不會拿舊部署的事件。
///   · 多個行程同時寫：先寫暫存檔再改名，最壞只是某一次的進度沒存到，下次重讀。
///   · **查核不用它**：`ledger-commit --verify` 與監理鏡像的重播直接讀鏈，不相信任何快取。
///
/// 不依賴 Next：網站與 scripts/ 共用。

export type IndexOpts = {
  /// 索引檔的資料夾（通常是 web/data/chain-index）
  dir: string;
  /// 事件種類，也是檔名
  name: string;
  /// 部署的識別（chainId、合約、deployedAt）。任何一個變了就不能沿用
  key: string;
  /// 幾塊以前的才寫進檔案。預設 12
  confirmations?: bigint;
};

type Doc<T> = { key: string; fromBlock: string; scannedTo: string; items: T[] };

/// 讀 [fromBlock, toBlock] 的事件，舊的從索引拿、新的向鏈上讀。
/// `blockOf` 取出一筆事件的區塊（用來切出「夠深」的部分與套用 toBlock）。
export async function indexedLogs<T>(o: IndexOpts & {
  fromBlock: bigint; toBlock: bigint;
  blockOf: (item: T) => bigint;
  fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>;
}): Promise<T[]> {
  const file = path.join(o.dir, `${o.name}.json`);
  const conf = o.confirmations ?? 12n;
  const fullKey = `${o.key}|${o.name}`;
  let doc: Doc<T> | null = null;
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"), reviver) as Doc<T>;
    if (d.key === fullKey && BigInt(d.fromBlock) === o.fromBlock) doc = d;
  } catch { /* 沒有索引或壞了：當作沒有 */ }

  const scannedTo = doc ? BigInt(doc.scannedTo) : o.fromBlock - 1n;
  const cached = doc ? doc.items : [];
  if (o.toBlock <= scannedTo) return cached.filter((x) => o.blockOf(x) <= o.toBlock);

  const fresh = await o.fetch(scannedTo + 1n, o.toBlock);
  const safe = o.toBlock - conf;
  if (safe > scannedTo) {
    const next: Doc<T> = {
      key: fullKey, fromBlock: String(o.fromBlock), scannedTo: String(safe),
      items: [...cached, ...fresh.filter((x) => o.blockOf(x) <= safe)],
    };
    try {
      fs.mkdirSync(o.dir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(next, replacer), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* 寫不進去（唯讀、磁碟滿）不影響這一次的結果 */ }
  }
  return [...cached, ...fresh];
}

/// 一次部署的索引設定：資料夾在 web/data/chain-index，鍵含鏈、合約與部署時間。本機鏈不留確認深度
///（anvil 不會分叉，測試常常一塊一塊挖）。
export function deploymentIndex(o: {
  dataDir: string; chainId: number; ledger: string; deployedAt?: number | string | null; local: boolean;
}): Omit<IndexOpts, "name"> {
  return {
    dir: path.join(o.dataDir, "chain-index"),
    key: `${o.chainId}|${o.ledger.toLowerCase()}|${o.deployedAt ?? ""}`,
    confirmations: o.local ? 0n : 12n,
  };
}
