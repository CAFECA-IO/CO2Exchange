import type { Address, PublicClient } from "viem";
import { apply, emptyState, toBalances, type State } from "./engine.ts";
import { BANK_EVENTS } from "./ledger-core.ts";
import { chainHash, GENESIS, orderLogRoot, type Event } from "./log.ts";
import { buildBalanceTree, totalsHashOf, type BalanceTree } from "./tree.ts";

/// 重播：委託單 log → 撮合 → 餘額樹。
///
/// **這是 B 期的全部重點。** A 期的餘額直接從鏈上事件推導，所以誰都算得出來；
/// B 期加進了鏈下的買賣，餘額不再是鏈上事件的簡單加總——那正是需要被驗證的地方。
///
/// 要驗的不變式只有一條：
///
/// ```
/// replay( orderLog_1 … orderLog_k )  ==  balanceTree_k
/// ```
///
/// 左邊是任何人都能自己算的（拿到 log 就能跑）；右邊的 root 在鏈上。
/// 對不上，就是交易所提交的餘額不是從它自己記錄的那些委託單算出來的。
/// 這句話不需要信任任何一方就成立，而那是整個設計唯一真正的保證。
///
/// ## 兩道獨立的檢查
///
/// 重播對得上還不夠。log 裡的「外部事件」（存入、註銷、提領）是交易所**宣稱**
/// 鏈上發生過的事——如果它可以在 log 裡塞一筆不存在的存入，餘額樹會完全自洽，
/// 而池子裡卻沒有那些東西。所以第二道檢查是：log 裡的每一筆外部事件，
/// 都要對得到鏈上真的有那個事件。
///
/// 兩道都過，才算「帳本沒有被捏造」。

export type ReplayResult = {
  state: State;
  tree: BalanceTree;
  orderLogRoot: `0x${string}`;
  runningHash: `0x${string}`;
  events: number;
  fills: number;
  rejected: { seq: bigint; reason: string }[];
};

export function replay(events: Event[], epoch: bigint, treasury?: Address): ReplayResult {
  const sorted = [...events].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  // 序號必須連續。缺號代表有人把事件抽掉了，而抽掉之後剩下的仍然會自洽——
  // 這正是雜湊鏈要存在的理由，但先在這裡擋一次，錯誤訊息比較具體。
  for (let i = 0; i < sorted.length; i++) {
    const want = BigInt(i + 1);
    if (sorted[i].seq !== want) {
      throw new Error(`委託單 log 缺號：第 ${i + 1} 筆的序號是 ${sorted[i].seq}，應該是 ${want}`);
    }
  }

  const state = apply(emptyState(), sorted);
  let running = GENESIS;
  for (const e of sorted) running = chainHash(running, e);

  const balances = toBalances(state, treasury);
  return {
    state,
    tree: buildBalanceTree(balances.length > 0 ? balances : [], epoch),
    orderLogRoot: orderLogRoot(sorted),
    runningHash: running,
    events: sorted.length,
    fills: state.fills.length,
    rejected: state.rejected,
  };
}

export type ExternalCheck = {
  ok: boolean;
  checked: number;
  problems: string[];
};

/// log 裡宣稱的外部事件，鏈上真的有嗎？
///
/// 比對的是 (種類, 帳戶, 批次, 數量) 的多重集合，不是逐筆對 txHash——
/// 因為同一個區塊裡可以有兩筆一模一樣的存入，而它們的順序在 log 裡是交易所排的。
/// 要對到 txHash 等級，log 的外部事件就得帶 logIndex 並且唯一，那是 C 期的事。
/// 現在這個強度擋得住「憑空多一筆」與「少記一筆」，那是主要的風險。
export async function checkExternalEvents(opts: {
  client: PublicClient;
  bank: Address;
  fromBlock: bigint;
  toBlock: bigint;
  events: Event[];
}): Promise<ExternalCheck> {
  const { client, bank, fromBlock, toBlock, events } = opts;
  const range = { address: bank, fromBlock, toBlock } as const;

  const [deposits, cashDeposits, retires, withdrawals, cashWithdrawals] = await Promise.all([
    client.getLogs({ ...range, event: BANK_EVENTS.deposited }),
    client.getLogs({ ...range, event: BANK_EVENTS.cashDeposited }),
    client.getLogs({ ...range, event: BANK_EVENTS.retiredFor }),
    client.getLogs({ ...range, event: BANK_EVENTS.withdrawn }),
    client.getLogs({ ...range, event: BANK_EVENTS.cashWithdrawn }),
  ]);

  const bag = new Map<string, number>();
  const key = (kind: string, account: string, id: bigint, amount: bigint) =>
    `${kind}|${account.toLowerCase()}|${id}|${amount}`;
  const put = (k: string, n: number) => bag.set(k, (bag.get(k) ?? 0) + n);

  type CreditLog = { args: { account?: Address; batchId?: bigint; amountKg?: bigint } };
  type CashLog = { args: { account?: Address; amount?: bigint } };
  const addCredit = (kind: string, logs: CreditLog[]) => {
    for (const l of logs) {
      if (!l.args.account || l.args.batchId === undefined || l.args.amountKg === undefined) continue;
      put(key(kind, l.args.account, l.args.batchId, l.args.amountKg), 1);
    }
  };
  const addCash = (kind: string, logs: CashLog[]) => {
    for (const l of logs) {
      if (!l.args.account || l.args.amount === undefined) continue;
      put(key(kind, l.args.account, 0n, l.args.amount), 1);
    }
  };
  addCredit("deposit", deposits);
  addCredit("retire", retires);
  addCredit("withdraw", withdrawals);
  addCash("cashDeposit", cashDeposits);
  addCash("cashWithdraw", cashWithdrawals);

  const problems: string[] = [];
  let checked = 0;
  for (const e of events) {
    let k: string | null = null;
    if (e.kind === "deposit" || e.kind === "retire" || e.kind === "withdraw") {
      k = key(e.kind, e.account, e.batchId, e.amountKg);
    } else if (e.kind === "cashDeposit" || e.kind === "cashWithdraw") {
      k = key(e.kind, e.account, 0n, e.amount);
    }
    if (!k) continue;
    checked += 1;
    const n = bag.get(k) ?? 0;
    if (n <= 0) problems.push(`log 第 ${e.seq} 筆宣稱的 ${e.kind} 在鏈上找不到（${k}）`);
    else put(k, -1);
  }
  // 反過來：鏈上有、log 裡沒有的，也是問題——那表示有人存了錢卻沒被記帳。
  for (const [k, n] of bag) {
    if (n > 0) problems.push(`鏈上有 ${n} 筆 ${k}，但 log 裡沒有記`);
  }

  return { ok: problems.length === 0, checked, problems };
}

export const totalsHashFor = (tree: BalanceTree) => totalsHashOf(tree.totalsByBatch, tree.root.cash);
