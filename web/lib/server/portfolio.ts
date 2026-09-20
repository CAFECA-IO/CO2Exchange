import "server-only";
import { parseAbiItem, type Address } from "viem";
import { creditAbi, erc20Abi, registryAbi } from "@/lib/abis";
import { countryCode } from "@/lib/deployment";
import { deployment, publicClient } from "./chain";
import { readTrades } from "./ticker";

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
/// 核發取得（專案方自己的額度）成本以 0 計，並在介面標示——代辦費不在鏈上，
/// 算進來只會是假的精確。

const FILLED = parseAbiItem(
  "event Filled(uint256 indexed orderId, address indexed buyer, uint256 amountKg, uint256 cost, uint256 fee)",
);
const LISTED = parseAbiItem(
  "event Listed(uint256 indexed orderId, address indexed seller, uint256 indexed batchId, uint256 amountKg, uint256 pricePerTonne, uint256 minFillKg)",
);
const ISSUED = parseAbiItem(
  "event BatchIssued(uint256 indexed batchId, uint256 indexed projectId, address indexed to, uint256 amountKg, bytes32 serialHash)",
);
const RETIRED = parseAbiItem(
  "event CreditRetired(uint256 indexed batchId, address indexed holder, address indexed certificateOwner, uint256 amountKg, uint256 certId)",
);

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
  cctKg: number; // 池化額度
  batches: Holding[];
  holdingKg: number; // 批次 + 池化
  avgCostPerTonne: number | null; // 移動加權平均成本
  marketPricePerTonne: number | null; // 最近成交價
  marketValue: number; // 持有量 × 市價
  costOfHolding: number; // 持有量 × 平均成本
  unrealisedPnl: number | null;
  realisedPnl: number;
  totalValue: number; // 現金 + 市值
  movements: Movement[];
  /// 淨值走勢：每一次異動後的「現金 + 持有市值（以當時價估）」
  equityCurve: { t: number; v: number }[];
  issuedKg: number; // 核發取得（成本 0）
};

export async function portfolio(account: Address): Promise<Portfolio> {
  const d = deployment();
  const me = account.toLowerCase();

  const [twd, cctRaw, listed, filled, issued, retired, trades] = await Promise.all([
    publicClient.readContract({ address: d.settlementToken, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    publicClient.readContract({ address: d.cct, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    publicClient.getLogs({ address: d.listing, event: LISTED, fromBlock: 0n }),
    publicClient.getLogs({ address: d.listing, event: FILLED, fromBlock: 0n }),
    publicClient.getLogs({ address: d.carbonCredit1155, event: ISSUED, fromBlock: 0n }),
    publicClient.getLogs({ address: d.carbonCredit1155, event: RETIRED, fromBlock: 0n }),
    readTrades(),
  ]);

  const orderSeller = new Map<number, string>();
  const orderBatch = new Map<number, number>();
  for (const l of listed) {
    orderSeller.set(Number(l.args.orderId), (l.args.seller as string).toLowerCase());
    orderBatch.set(Number(l.args.orderId), Number(l.args.batchId));
  }

  const blocks = [...new Set([...filled, ...issued, ...retired].map((l) => l.blockNumber!))];
  const times = new Map<bigint, number>();
  await Promise.all(blocks.map(async (bn) => {
    times.set(bn, Number((await publicClient.getBlock({ blockNumber: bn })).timestamp));
  }));
  const at = (bn: bigint) => times.get(bn) ?? 0;

  const movements: Movement[] = [];
  let issuedKg = 0;

  for (const l of issued) {
    if ((l.args.to as string).toLowerCase() !== me) continue;
    issuedKg += Number(l.args.amountKg);
    movements.push({
      ts: at(l.blockNumber!), kind: "issue", batchId: Number(l.args.batchId),
      kg: Number(l.args.amountKg), pricePerTonne: null, cashDelta: 0, txHash: l.transactionHash!,
    });
  }
  for (const l of filled) {
    const orderId = Number(l.args.orderId);
    const kg = Number(l.args.amountKg);
    const cost = Number(l.args.cost);
    const fee = Number(l.args.fee);
    const price = kg > 0 ? (cost * 1000) / kg : null;
    const batchId = orderBatch.get(orderId) ?? 0;
    const ts = at(l.blockNumber!);
    if ((l.args.buyer as string).toLowerCase() === me) {
      movements.push({ ts, kind: "buy", batchId, kg, pricePerTonne: price, cashDelta: -cost, txHash: l.transactionHash! });
    }
    if (orderSeller.get(orderId) === me) {
      // 手續費由賣方承擔，所以賣方實收是 cost - fee
      movements.push({ ts, kind: "sell", batchId, kg, pricePerTonne: price, cashDelta: cost - fee, txHash: l.transactionHash! });
    }
  }
  for (const l of retired) {
    if ((l.args.holder as string).toLowerCase() !== me) continue;
    movements.push({
      ts: at(l.blockNumber!), kind: "retire", batchId: Number(l.args.batchId),
      kg: Number(l.args.amountKg), pricePerTonne: null, cashDelta: 0, txHash: l.transactionHash!,
    });
  }
  movements.sort((a, b) => a.ts - b.ts);

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

  const batches = await myBatches(account);
  const cctKg = Number(cctRaw) / 1e15;
  const holdingKg = batches.reduce((s, b) => s + b.kg, 0) + cctKg;
  const avgCostPerTonne = posKg > 0 ? (posCost / posKg) * 1000 : null;
  const marketPricePerTonne = trades.length ? trades[trades.length - 1].pricePerTonne : null;
  const marketValue = marketPricePerTonne ? (holdingKg / 1000) * marketPricePerTonne : 0;
  const costOfHolding = avgCostPerTonne ? (holdingKg / 1000) * avgCostPerTonne : 0;

  return {
    twd: Number(twd),
    cctKg,
    batches,
    holdingKg,
    avgCostPerTonne,
    marketPricePerTonne,
    marketValue,
    costOfHolding,
    unrealisedPnl: marketPricePerTonne && avgCostPerTonne ? marketValue - costOfHolding : null,
    realisedPnl,
    totalValue: Number(twd) + marketValue,
    movements: movements.slice().reverse(),
    equityCurve,
    issuedKg,
  };
}

/// 目前持有的批次。與 market.ts 的邏輯相同，但這裡只要自己的，掃描範圍小得多。
async function myBatches(account: Address): Promise<Holding[]> {
  const d = deployment();
  const logs = await publicClient.getLogs({ address: d.carbonCredit1155, event: ISSUED, fromBlock: 0n });
  const ids = [...new Set(logs.map((l) => Number(l.args.batchId)))];
  if (ids.length === 0) return [];
  const out: Holding[] = [];
  for (const id of ids) {
    const bal = await publicClient.readContract({
      address: d.carbonCredit1155, abi: creditAbi, functionName: "balanceOf", args: [account, BigInt(id)],
    });
    if (Number(bal) === 0) continue;
    const b = await publicClient.readContract({ address: d.carbonCredit1155, abi: creditAbi, functionName: "batchOf", args: [BigInt(id)] });
    const p = await publicClient.readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "projectOf", args: [b.projectId] });
    out.push({
      batchId: id, project: p.name, vintageYear: b.vintageYear, kg: Number(bal),
      country: countryCode(p.country), scheme: p.scheme,
    });
  }
  return out;
}
