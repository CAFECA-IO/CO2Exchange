import type { Address, PublicClient } from "viem";
import { readCashEvents, type Range } from "./chain.ts";
import type { Event } from "./events.ts";
import type { ReceiptSigner, Store } from "./store.ts";

/// 把鏈上的新台幣入金／出金確認鏡像進帳本。
///
/// 入金與出金由營運 Safe 在鏈上確認（CashDeposited／CashWithdrawn），帳本只是**記下這件事**。
/// 所以這些事件不是誰簽的，而是由 ChainRef（tx hash ＋ log index）背書——查核者拿同一條鏈
/// 就能逐筆比對，`ledger-commit --verify` 會雙向檢查（鏈上有、帳本沒有也算錯）。
///
/// 網站、營運工具（確認之後）、承諾工具（每期提交前）都會呼叫它；多個行程同時跑是常態，
/// 所以去重在帳本的寫入鎖裡做（`appendIf`），不能在鎖外先查再寫。
///
/// 不依賴 Next——承諾工具與查核工具直接 import。

const keyOf = (ref: { txHash: string; logIndex: number }) => `${ref.txHash.toLowerCase()}:${ref.logIndex}`;

/// 帳本裡已經記過的鏈上事件，依帳本資料夾留在記憶體裡、只讀新增的那幾筆。
/// 常駐的網站每一次入出金都呼叫 mirrorCash——每次都把整份帳本讀一遍，帳本越大越慢。
/// 用 head 的雜湊鏈確認沒有被重建：接不上就從頭讀。
const knownByStore = new Map<string, { seq: bigint; running: string; keys: Set<string> }>();

export async function mirrorCash(opts: {
  store: Store;
  client: PublicClient;
  ledger: Address;
  fromBlock: bigint;
  receiptSigner?: ReceiptSigner;
  /// 增量索引（見 logindex.ts）
  index?: Range["index"];
}): Promise<{ added: Event[] }> {
  const { store, client, ledger, fromBlock, receiptSigner } = opts;
  const atBlock = await client.getBlockNumber({ cacheTime: 0 });
  const onchain = await readCashEvents(client, ledger, { fromBlock, toBlock: atBlock, index: opts.index });
  if (onchain.length === 0) return { added: [] };

  // 已經記過的鏈上事件。鎖裡再補上鎖外沒看到的那幾筆（別的行程剛寫的）。
  const memoKey = `${store.dir}|${ledger.toLowerCase()}`;
  let memo = knownByStore.get(memoKey);
  const refresh = () => {
    const h = store.head();
    if (memo && h.seq === memo.seq && h.runningHash === memo.running) return;
    // 帳本變短了（被重建）就從頭讀
    if (!memo || h.seq < memo.seq) memo = { seq: 0n, running: "", keys: new Set() };
    for (const e of store.read(memo.seq + 1n)) if ("ref" in e && e.ref) memo.keys.add(keyOf(e.ref));
    memo.seq = h.seq; memo.running = h.runningHash;
    knownByStore.set(memoKey, memo);
  };
  const known = { has: (k: string) => memo!.keys.has(k), add: (k: string) => memo!.keys.add(k) };
  refresh();

  const added: Event[] = [];
  for (const c of onchain) {
    const k = keyOf(c.ref);
    if (known.has(k)) continue;
    const r = await store.appendIf({ atBlock, ...c }, {
      receiptSigner,
      skipIf: () => { refresh(); return known.has(k); },
    });
    if (r) { added.push(r.event); known.add(k); }
  }
  return { added };
}
