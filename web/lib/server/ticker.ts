import "server-only";
import { parseAbiItem } from "viem";
import { deployment, publicClient } from "./chain";

/// 行情全部由鏈上 Listing 的 Filled 事件推導，沒有任何捏造的數字。
/// Filled(orderId, buyer, amountKg, cost, fee) —— 成交價 = cost / amountKg * 1000（每噸，結算幣最小單位）。
const FILLED = parseAbiItem(
  "event Filled(uint256 indexed orderId, address indexed buyer, uint256 amountKg, uint256 cost, uint256 fee)",
);

export type Trade = { ts: number; pricePerTonne: number; kg: number; cost: number; txHash: string };
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Ticker = {
  pair: string;
  last: number | null;
  open: number | null;
  change: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  volumeKg: number;
  volumeTwd: number;
  tradeCount: number;
  candles: Candle[];
  trades: Trade[];
  rangeHours: number;
  bucketMinutes: number;
  carbonFeePerTonne: number | null;
};

/// 依成交筆數自動選桶寬，讓稀疏的資料也畫得出形狀。
function bucketFor(rangeHours: number): number {
  if (rangeHours <= 6) return 5;
  if (rangeHours <= 24) return 15;
  if (rangeHours <= 24 * 7) return 60;
  return 60 * 24;
}

export async function readTrades(): Promise<Trade[]> {
  const d = deployment();
  const logs = await publicClient.getLogs({ address: d.listing, event: FILLED, fromBlock: 0n });
  if (logs.length === 0) return [];

  // 逐區塊取時間戳（同一區塊只取一次）
  const blocks = [...new Set(logs.map((l) => l.blockNumber!))];
  const times = new Map<bigint, number>();
  await Promise.all(
    blocks.map(async (bn) => {
      const b = await publicClient.getBlock({ blockNumber: bn });
      times.set(bn, Number(b.timestamp));
    }),
  );

  return logs
    .map((l) => {
      const kg = Number(l.args.amountKg ?? 0n);
      const cost = Number(l.args.cost ?? 0n);
      return {
        ts: times.get(l.blockNumber!) ?? 0,
        // 每噸價格：cost 是結算幣最小單位（6 decimals），kg → 噸要乘 1000
        pricePerTonne: kg > 0 ? (cost * 1000) / kg : 0,
        kg,
        cost,
        txHash: l.transactionHash!,
      };
    })
    .filter((t) => t.kg > 0)
    .sort((a, b) => a.ts - b.ts);
}

export function toCandles(trades: Trade[], bucketMinutes: number): Candle[] {
  const size = bucketMinutes * 60;
  const byBucket = new Map<number, Trade[]>();
  for (const t of trades) {
    const k = Math.floor(t.ts / size) * size;
    const group = byBucket.get(k);
    if (group) group.push(t);
    else byBucket.set(k, [t]);
  }
  const keys = [...byBucket.keys()].sort((a, b) => a - b);
  const out: Candle[] = [];
  let prevClose: number | null = null;
  for (const k of keys) {
    const group = byBucket.get(k)!;
    const prices = group.map((g) => g.pricePerTonne);
    const candle: Candle = {
      t: k,
      // 用前一根的收盤當這根的開盤，價格才是連續的；第一根以自己的首筆成交為開盤
      o: prevClose ?? prices[0],
      h: Math.max(...prices, prevClose ?? prices[0]),
      l: Math.min(...prices, prevClose ?? prices[0]),
      c: prices[prices.length - 1],
      v: group.reduce((s, g) => s + g.kg, 0),
    };
    out.push(candle);
    prevClose = candle.c;
  }
  return out;
}

export async function ticker(rangeHours = 24 * 7): Promise<Ticker> {
  const all = await readTrades();
  const now = all.length ? all[all.length - 1].ts : Math.floor(Date.now() / 1000);
  const from = now - rangeHours * 3600;
  const trades = all.filter((t) => t.ts >= from);
  const bucketMinutes = bucketFor(rangeHours);
  const candles = toCandles(trades, bucketMinutes);

  const last = trades.length ? trades[trades.length - 1].pricePerTonne : null;
  // 區間開盤 = 區間內第一筆成交；若區間前已有成交，用那筆當開盤才算得出真正的漲跌
  const before = all.filter((t) => t.ts < from);
  const open = before.length
    ? before[before.length - 1].pricePerTonne
    : trades.length
      ? trades[0].pricePerTonne
      : null;

  const prices = trades.map((t) => t.pricePerTonne);
  const change = last !== null && open !== null ? last - open : null;
  const fee = process.env.CARBON_FEE_PER_TONNE ? Number(process.env.CARBON_FEE_PER_TONNE) : null;

  return {
    pair: "CCT / mTWD",
    last,
    open,
    change,
    changePct: change !== null && open ? (change / open) * 100 : null,
    high: prices.length ? Math.max(...prices) : null,
    low: prices.length ? Math.min(...prices) : null,
    volumeKg: trades.reduce((s, t) => s + t.kg, 0),
    volumeTwd: trades.reduce((s, t) => s + t.cost, 0),
    tradeCount: trades.length,
    candles,
    trades: trades.slice(-40).reverse(),
    rangeHours,
    bucketMinutes,
    carbonFeePerTonne: fee,
  };
}
