import { parseAbiItem, type Address, type PublicClient } from "viem";
import type { AccountBalance } from "./tree.ts";

/// 從鏈上事件推導出「誰在 Bank 裡有多少」。
///
/// **這個檔案不依賴 Next、不依賴 `server-only`、不用路徑別名。**
/// 理由很實際：每 24 小時提交一次 root 的那支排程要能在 Next 之外跑
/// （cron、另一台機器、或查核機構自己跑一份來對帳），而稽核方更不可能為了
/// 重算一棵樹去啟動一個 Next 伺服器。
///
/// 所以鏈的連線由呼叫端注入。同一份推導邏輯，三個地方共用：
///   · Next 的 API（用站上的 publicClient）
///   · `scripts/commit-epoch.mjs`（自己開一個 client）
///   · 任何想自己驗證的人（照著這個檔案重寫一份，或直接跑它）
///
/// 把它抄成兩份的代價不是重複，是兩份會漂移——而漂移的症狀是
/// 「使用者的提領證據驗不過」，要等到有人真的去提領才會發現。
///
/// ## A 期的不變式
///
/// ```
/// 餘額 = Σ(Deposited) + Σ(CashDeposited) − Σ(RetiredFor) − Σ(Withdrawn)
/// ```
///
/// 三種事件都在鏈上，所以任何人都算得出同一棵樹。B 期接上委託單 log 之後，
/// 不變式會擴充成「重播 log 得到同一棵樹」，而這一份會變成它的邊界條件
/// （存入與提領是外部事件，買賣是內部事件）。
///
/// 先做可驗證的那一半，再做需要信任的那一半。順序反過來的話，
/// 第一期交出去的東西沒有人能檢查。

export const BANK_EVENTS = {
  deposited: parseAbiItem("event Deposited(address indexed account, uint256 indexed batchId, uint256 amountKg)"),
  cashDeposited: parseAbiItem("event CashDeposited(address indexed account, uint256 amount)"),
  retiredFor: parseAbiItem(
    "event RetiredFor(address indexed account, uint256 indexed batchId, uint256 amountKg, uint256 certId)",
  ),
  withdrawn: parseAbiItem(
    "event Withdrawn(address indexed account, uint256 indexed batchId, uint256 amountKg, uint64 epoch)",
  ),
  cashWithdrawn: parseAbiItem("event CashWithdrawn(address indexed account, uint256 amount, uint64 epoch)"),
} as const;

export type Ledger = {
  balances: AccountBalance[];
  fromBlock: bigint;
  /// 算到哪一個區塊為止。這個數字會跟著 root 一起上鏈——
  /// 沒有它，「任何人都能重算同一棵樹」是一句空話：重算的人不知道該讀到哪裡。
  toBlock: bigint;
  totalKg: bigint;
  totalCash: bigint;
};

const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);

export async function deriveLedger(opts: {
  client: PublicClient;
  bank: Address;
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<Ledger> {
  const { client, bank, fromBlock, toBlock } = opts;
  const range = { address: bank, fromBlock, toBlock } as const;

  const [deposits, cashDeposits, retires, withdrawals, cashWithdrawals] = await Promise.all([
    client.getLogs({ ...range, event: BANK_EVENTS.deposited }),
    client.getLogs({ ...range, event: BANK_EVENTS.cashDeposited }),
    client.getLogs({ ...range, event: BANK_EVENTS.retiredFor }),
    client.getLogs({ ...range, event: BANK_EVENTS.withdrawn }),
    client.getLogs({ ...range, event: BANK_EVENTS.cashWithdrawn }),
  ]);

  const credits = new Map<string, bigint>(); // `${account}:${batchId}`
  const cash = new Map<string, bigint>();

  const applyCredit = (
    logs: { args: { account?: Address; batchId?: bigint; amountKg?: bigint } }[],
    sign: bigint,
  ) => {
    for (const l of logs) {
      const { account, batchId, amountKg } = l.args;
      if (!account || batchId === undefined || amountKg === undefined) continue;
      add(credits, `${account.toLowerCase()}:${batchId}`, sign * amountKg);
    }
  };
  const applyCash = (logs: { args: { account?: Address; amount?: bigint } }[], sign: bigint) => {
    for (const l of logs) {
      const { account, amount } = l.args;
      if (!account || amount === undefined) continue;
      add(cash, account.toLowerCase(), sign * amount);
    }
  };

  applyCredit(deposits, 1n);
  applyCredit(retires, -1n);
  applyCredit(withdrawals, -1n);
  applyCash(cashDeposits, 1n);
  applyCash(cashWithdrawals, -1n);

  const byAccount = new Map<string, AccountBalance>();
  const ensure = (addr: string) =>
    byAccount.get(addr) ?? byAccount.set(addr, { account: addr as Address, assets: [], cash: 0n }).get(addr)!;

  for (const [key, kg] of credits) {
    // 零餘額的葉子只是雜訊；負數代表推導錯了，而那要大聲一點，不要默默當成 0
    if (kg === 0n) continue;
    if (kg < 0n) throw new Error(`推導出負的碳權餘額（${key} = ${kg}），事件處理有錯，不要拿這棵樹去提交`);
    const [addr, batch] = key.split(":");
    ensure(addr).assets.push({ batchId: BigInt(batch), kg });
  }
  for (const [addr, amount] of cash) {
    if (amount === 0n) continue;
    if (amount < 0n) throw new Error(`推導出負的現金餘額（${addr} = ${amount}）`);
    ensure(addr).cash += amount;
  }

  const balances = [...byAccount.values()];
  return {
    balances,
    fromBlock,
    toBlock,
    totalKg: balances.reduce((s, b) => s + b.assets.reduce((t, a) => t + a.kg, 0n), 0n),
    totalCash: balances.reduce((s, b) => s + b.cash, 0n),
  };
}
