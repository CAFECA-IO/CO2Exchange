import "server-only";
import { erc20Abi, type Address } from "viem";
import { deployment, publicClient } from "./chain";
import { ledgerPortfolio } from "./ledger/read";

/// 我的資產：持有、成本、市值、賺賠。
///
/// 成本基礎用**移動加權平均**，不是先進先出——碳權是同質的（同批次內每一公噸一樣），
/// 使用者也不會記得自己先買的是哪一噸，加權平均是他心裡預期的算法。
///
/// 三個數字要分清楚，否則使用者會以為自己賺了其實沒有：
///   已實現損益 = 賣出價金（扣手續費後實收）− 賣出當下的平均成本 × 賣出量
///   未實現損益 = （目前市價 − 平均成本）× 現在持有量
///   總損益     = 兩者相加
///
/// 核發取得（專案方自己的額度）成本以 0 計，並在介面標示——代辦費不在帳本裡，
/// 算進來只會是假的精確。

export type Movement = {
  ts: number;
  kind: "issue" | "buy" | "sell" | "retire";
  batchId: number;
  kg: number;
  /// 買賣的每噸價（結算幣最小單位）；核發與註銷為 null
  pricePerTonne: number | null;
  /// 買＝支出、賣＝實收（已扣手續費）
  cashDelta: number;
  txHash: string;
};

export type Holding = { batchId: number; project: string; vintageYear: number; kg: number; country: string; scheme: string };

export type Portfolio = {
  twd: number; // 結算幣餘額（最小單位）
  cctKg: number; // 未指定批次的額度（帳本版恆為 0，保留欄位給畫面）
  batches: Holding[];
  holdingKg: number; // 各批次合計
  avgCostPerTonne: number | null; // 移動加權平均成本
  marketPricePerTonne: number | null; // 最近成交價
  marketValue: number; // 持有量 × 市價
  costOfHolding: number; // 持有量 × 平均成本
  unrealisedPnl: number | null;
  realisedPnl: number;
  totalValue: number; // 現金 + 市值
  /// 錢包裡還沒存進帳本合約的結算幣（鏈上餘額）。null = 讀不到
  walletTwd?: number | null;
  movements: Movement[];
  /// 淨值走勢：每一次異動後的「現金 + 持有市值（以當時價估）」
  equityCurve: { t: number; v: number }[];
  issuedKg: number; // 核發取得（成本 0）
};

export async function portfolio(account: Address): Promise<Portfolio> {
  // 「現金」是帳本裡的餘額；錢包裡的結算幣要存入才能交易，兩個數字都要讓人看得到
  const walletTwd = await publicClient
    .readContract({ address: deployment().settlementToken, abi: erc20Abi, functionName: "balanceOf", args: [account] })
    .then(Number).catch(() => null);
  return { ...ledgerPortfolio(account), walletTwd };
}

/// 損益的算法本身（與資料從哪裡來無關）。lib/server/ledger/read.ts 用它。
export function computePortfolio(input: {
  twd: number; cctKg: number; batches: Holding[]; movements: Movement[]; issuedKg: number; marketPricePerTonne: number | null;
}): Portfolio {
  const { twd, cctKg, batches, issuedKg, marketPricePerTonne } = input;
  const movements = [...input.movements].sort((a, b) => a.ts - b.ts);

  // 移動加權平均
  let posKg = 0;
  let posCost = 0; // 持有部位的總成本
  let realisedPnl = 0;
  let cash = 0; // 相對現金流，只用來畫淨值曲線的形狀
  const equityCurve: { t: number; v: number }[] = [];

  for (const m of movements) {
    const avg = posKg > 0 ? posCost / posKg : 0;
    if (m.kind === "buy") {
      posKg += m.kg; posCost += -m.cashDelta; cash += m.cashDelta;
    } else if (m.kind === "issue") {
      posKg += m.kg; // 成本 0
    } else if (m.kind === "sell") {
      const sold = Math.min(m.kg, posKg);
      realisedPnl += m.cashDelta - avg * sold;
      posKg -= sold; posCost -= avg * sold; cash += m.cashDelta;
    } else if (m.kind === "retire") {
      const used = Math.min(m.kg, posKg);
      posKg -= used; posCost -= avg * used; // 註銷＝用掉，成本認列但不算損益
    }
    const markPrice = m.pricePerTonne ?? (posKg > 0 ? posCost / posKg : 0) * 1;
    equityCurve.push({ t: m.ts, v: cash + (posKg / 1000) * markPrice });
  }

  const holdingKg = batches.reduce((s, b) => s + b.kg, 0) + cctKg;
  const avgCostPerTonne = posKg > 0 ? (posCost / posKg) * 1000 : null;
  const marketValue = marketPricePerTonne ? (holdingKg / 1000) * marketPricePerTonne : 0;
  const costOfHolding = avgCostPerTonne ? (holdingKg / 1000) * avgCostPerTonne : 0;

  return {
    twd,
    cctKg,
    batches,
    holdingKg,
    avgCostPerTonne,
    marketPricePerTonne,
    marketValue,
    costOfHolding,
    unrealisedPnl: marketPricePerTonne && avgCostPerTonne ? marketValue - costOfHolding : null,
    realisedPnl,
    totalValue: twd + marketValue,
    movements: movements.slice().reverse(),
    equityCurve,
    issuedKg,
  };
}
