import type { Address, PublicClient } from "viem";
import { readCashEvents } from "./chain.ts";
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

export async function mirrorCash(opts: {
  store: Store;
  client: PublicClient;
  ledger: Address;
  fromBlock: bigint;
  receiptSigner?: ReceiptSigner;
}): Promise<{ added: Event[] }> {
  const { store, client, ledger, fromBlock, receiptSigner } = opts;
  const atBlock = await client.getBlockNumber({ cacheTime: 0 });
  const onchain = await readCashEvents(client, ledger, { fromBlock, toBlock: atBlock });
  if (onchain.length === 0) return { added: [] };

  // 已經記過的鏈上事件。鎖裡再補上鎖外沒看到的那幾筆（別的行程剛寫的）。
  const known = new Set<string>();
  let knownSeq = 0n;
  const refresh = () => {
    const h = store.head();
    if (h.seq <= knownSeq) return;
    for (const e of store.read(knownSeq + 1n)) if ("ref" in e && e.ref) known.add(keyOf(e.ref));
    knownSeq = h.seq;
  };
  refresh();

  const added: Event[] = [];
  for (const c of onchain) {
    const k = keyOf(c.ref);
    if (known.has(k)) continue;
    const r = await store.appendIf({ atBlock, ...c }, {
      receiptSigner,
      skipIf: () => { refresh(); return known.has(k); },
    });
    if (r) { added.push(r.event); known.add(k); knownSeq = r.event.seq; }
  }
  return { added };
}
