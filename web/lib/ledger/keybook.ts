import { type Address, type Hex, type PublicClient } from "viem";
import { readKeyLogs, readModuleLogs } from "./chain.ts";
import type { Event, EventOf } from "./events.ts";
import { buildKeyBook, emptyKeyBook, type KeyBook } from "./signatures.ts";

/// 查核用的金鑰簿：帳本裡的 `userKey` 鏡像（座標）＋ 鏈上的 KeyAdded／KeyRemoved／模組事件（有效區間）。
///
/// 只讀**事件**，不讀合約狀態——事件不會被裁剪，所以不需要 archive 節點。
/// 不依賴 Next：查核機構的工具直接 import。
export async function loadKeyBook(client: PublicClient, opts: {
  keyring: Address | null;
  events: Event[];
  /// CAFECA keyring 的事件從哪一塊開始讀（帳戶可能早於帳本部署就建立了）。預設 0
  fromBlock?: bigint;
  toBlock?: bigint;
  rpIdHash?: Hex;
}): Promise<{ book: KeyBook; problems: string[] }> {
  const mirrors = opts.events.filter((e): e is EventOf<"userKey"> => e.kind === "userKey");
  if (!opts.keyring) {
    return {
      book: emptyKeyBook(),
      problems: mirrors.length ? [`帳本裡有 ${mirrors.length} 筆 CAFECA 金鑰鏡像，但沒有設定 keyring 位址（CAFECA_KEYRING）`] : [],
    };
  }
  const range = { fromBlock: opts.fromBlock ?? 0n, toBlock: opts.toBlock };
  const accounts = [...new Set(mirrors.map((m) => m.account.toLowerCase()))] as Address[];
  const [keyLogs, moduleLogs] = await Promise.all([
    readKeyLogs(client, opts.keyring, range),
    readModuleLogs(client, accounts, range),
  ]);
  return buildKeyBook({
    keyring: opts.keyring,
    mirrors: mirrors.map((m) => ({ account: m.account, keyId: m.keyId, qx: m.qx, qy: m.qy, rpIdHash: m.rpIdHash, validator: m.validator, ref: { txHash: m.ref.txHash, logIndex: m.ref.logIndex } })),
    keyLogs, moduleLogs, rpIdHash: opts.rpIdHash,
  });
}
