import "server-only";
import { encodeAbiParameters, keccak256, encodePacked, type Address, type Hex } from "viem";
import { creditAbi, erc20Abi, kycRegistryAbi, listingAbi, poolAbi, poolManagerAbi, registryAbi, routerAbi } from "@/lib/abis";
import { errorAbi } from "@/lib/error-abi";
import { deployment, publicClient } from "./chain";
import { countryCode, hasV4 } from "@/lib/deployment";

/// v4 的價格上下界。方向只看 zeroForOne，與精準輸入／輸出無關。
const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;

export type Order = {
  orderId: number; seller: Address; batchId: number; remainingKg: number; pricePerTonne: string; minFillKg: number;
  project: { name: string; methodology: string; location: string }; vintageYear: number;
  /// 核發國（ISO 3166-1 alpha-2）與機制名稱。決定買到之後能拿來做什麼。
  country: string; scheme: string; domestic: boolean;
};

/// SKIP_V4 部署時回 null —— 呼叫端據此隱藏 v4 相關 UI。
export function poolKey() {
  const d = deployment();
  if (!hasV4(d)) return null;
  const [c0, c1] = d.cct.toLowerCase() < d.settlementToken.toLowerCase() ? [d.cct, d.settlementToken] : [d.settlementToken, d.cct];
  return { currency0: c0, currency1: c1, fee: d.poolFee, tickSpacing: d.tickSpacing, hooks: d.hook } as const;
}

export function poolId() {
  const k = poolKey();
  if (!k) return null;
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
  ));
}

/// v4 現貨價：sqrtPriceX96 → mTWD / 噸（6 decimals），不含手續費與滑價
export async function poolSpotPricePerTonne(): Promise<number | null> {
  const d = deployment();
  const pid = poolId();
  if (!pid) return null; // SKIP_V4 部署：沒有 v4 池，也就沒有現貨價
  const slot = keccak256(encodePacked(["bytes32", "bytes32"], [pid, `0x${(6).toString(16).padStart(64, "0")}`]));
  const raw = await publicClient.readContract({ address: d.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [slot] });
  const sqrtP = BigInt(raw) & ((1n << 160n) - 1n);
  if (sqrtP === 0n) return null;
  // price1/0 = (sqrtP / 2^96)^2 ；用 1e18 精度做整數運算
  const priceX = (sqrtP * sqrtP * 10n ** 18n) >> 192n; // amount1 per amount0 * 1e18
  const twdIs0 = poolKey()!.currency0.toLowerCase() === d.settlementToken.toLowerCase();
  // 1 噸 = 1e18 CCT raw；TWD raw(6 dec) / 噸：
  //   CCT 是 currency0 → price = TWD/CCT → perTonne = priceX
  //   TWD 是 currency0 → price = CCT/TWD → perTonne = 1e36 / priceX
  const perTonne6 = twdIs0 ? (10n ** 36n) / priceX : priceX;
  return Number(perTonne6) / 1e6;
}

/// 掛單簿。從最新的 orderId 往回掃，收滿 limit 筆有效單就停。
///
/// 原本是從 1 一路掃到 nextOrderId、每筆三次 contract read。鋪了一年的模擬資料
/// 之後有上千筆單，這條路要三秒以上。改成往回掃 + 分批平行讀，並限制掃描深度。
export async function listOrders(limit = 60, maxScan = 400): Promise<Order[]> {
  const d = deployment();
  const next = Number(await publicClient.readContract({ address: d.listing, abi: listingAbi, functionName: "nextOrderId" }));
  const ids: number[] = [];
  for (let i = next - 1; i >= 1 && ids.length < maxScan; i--) ids.push(i);

  const out: Order[] = [];
  const CHUNK = 40;
  for (let i = 0; i < ids.length && out.length < limit; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const orders = await Promise.all(
      slice.map((id) =>
        publicClient.readContract({ address: d.listing, abi: listingAbi, functionName: "orderOf", args: [BigInt(id)] })
          .then((o) => ({ id, o })),
      ),
    );
    const active = orders.filter((x) => x.o.active && x.o.remainingKg > 0n);
    if (active.length === 0) continue;

    // 批次與專案資料會大量重複，查過就快取
    const batches = await Promise.all(
      [...new Set(active.map((x) => x.o.batchId))].map((bid) =>
        publicClient.readContract({ address: d.carbonCredit1155, abi: creditAbi, functionName: "batchOf", args: [bid] })
          .then((b) => [bid.toString(), b] as const),
      ),
    );
    const byBatch = new Map(batches);
    const projects = await Promise.all(
      [...new Set(batches.map(([, b]) => b.projectId))].map((pid) =>
        publicClient.readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "projectOf", args: [pid] })
          .then((p) => [pid.toString(), p] as const),
      ),
    );
    const byProject = new Map(projects);

    for (const { id, o } of active) {
      if (out.length >= limit) break;
      const b = byBatch.get(o.batchId.toString())!;
      const p = byProject.get(b.projectId.toString())!;
      out.push({
        orderId: id, seller: o.seller, batchId: Number(o.batchId), remainingKg: Number(o.remainingKg),
        pricePerTonne: o.pricePerTonne.toString(), minFillKg: Number(o.minFillKg),
        project: { name: p.name, methodology: p.methodology, location: p.location }, vintageYear: b.vintageYear,
        country: countryCode(p.country), scheme: p.scheme, domestic: countryCode(p.country) === "TW",
      });
    }
  }
  // 掛單簿由低價往高價排（最佳賣價在前）
  return out.sort((a, b) => Number(BigInt(a.pricePerTonne) - BigInt(b.pricePerTonne)));
}

export type Bid = {
  bidId: number;
  buyer: Address;
  /// 想買哪一國核發的；空字串＝不限
  country: string;
  remainingKg: number;
  pricePerTonne: string;
  minFillKg: number;
};

/// 買單側。比賣單簡單得多——買單只帶核發國，不牽涉批次與專案，
/// 所以不必像 listOrders 那樣回頭查批次與專案的資料。
export async function listBids(limit = 60, maxScan = 400): Promise<Bid[]> {
  const d = deployment();
  const next = Number(
    await publicClient.readContract({ address: d.listing, abi: listingAbi, functionName: "nextBidId" }).catch(() => 1n),
  );
  const ids: number[] = [];
  for (let i = next - 1; i >= 1 && ids.length < maxScan; i--) ids.push(i);

  const out: Bid[] = [];
  const CHUNK = 40;
  for (let i = 0; i < ids.length && out.length < limit; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const bids = await Promise.all(
      slice.map((id) =>
        publicClient.readContract({ address: d.listing, abi: listingAbi, functionName: "bidOf", args: [BigInt(id)] })
          .then((b) => ({ id, b })),
      ),
    );
    for (const { id, b } of bids) {
      if (out.length >= limit) break;
      if (!b.active || b.remainingKg === 0n) continue;
      out.push({
        bidId: id, buyer: b.buyer, country: countryCode(b.country),
        remainingKg: Number(b.remainingKg), pricePerTonne: b.pricePerTonne.toString(),
        minFillKg: Number(b.minFillKg),
      });
    }
  }
  // 買單由高價往低價排：最佳買價（出得最多的）在前，跟賣單那側的「最佳」方向相反。
  return out.sort((a, b) => Number(BigInt(b.pricePerTonne) - BigInt(a.pricePerTonne)));
}

export async function holdings(account: Address) {
  const d = deployment();
  const [twd, cct, ids] = await Promise.all([
    publicClient.readContract({ address: d.settlementToken, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    publicClient.readContract({ address: d.cct, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    publicClient.readContract({ address: d.carbonCredit1155, abi: creditAbi, functionName: "heldBatches", args: [account] }),
  ]);
  const batches = await Promise.all(ids.map(async (id) => {
    const [bal, b] = await Promise.all([
      publicClient.readContract({ address: d.carbonCredit1155, abi: creditAbi, functionName: "balanceOf", args: [account, id] }),
      publicClient.readContract({ address: d.carbonCredit1155, abi: creditAbi, functionName: "batchOf", args: [id] }),
    ]);
    const p = await publicClient.readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "projectOf", args: [b.projectId] });
    return {
      batchId: Number(id), kg: Number(bal), vintageYear: b.vintageYear, project: p.name,
      country: countryCode(p.country), scheme: p.scheme,
    };
  }));
  const pooled = await publicClient.readContract({ address: d.carbonPool, abi: poolAbi, functionName: "pooledKg", args: [1n] }).catch(() => 0n);
  return { twd: twd.toString(), cct: cct.toString(), batches: batches.filter((b) => b.kg > 0), pooledKgBatch1: pooled.toString() };
}

/// 市價買賣的**實際**成本，用模擬的方式問鏈，不是用現貨價推算。
///
/// 為什麼一定要問：v4 的池子是曲線，精準輸出的成交價是**沿路的平均價**，
/// 不是現貨價。池子薄的時候差距大到荒謬——實測這個 demo 池：
/// 買 1 噸比現貨貴 3.7%，5 噸貴 19.6%，20 噸貴 183%，50 噸直接吃光流動性。
/// 前端原本用「現貨 × 1.05」估最高支付並照那個數字授權，於是 5 噸以上必定失敗，
/// 而畫面上那個「最高支付」根本不是使用者會付的錢。
///
/// 做法是 eth_call 模擬 `TrustedRouter.swap`，並用 state override 暫時給足餘額與授權
/// （只存在於這一次模擬，不上鏈）。回傳的 BalanceDelta 就是真正的進出金額。
/// 報不出價時**為什麼**報不出來。
///
/// 以前這裡回 null，前端一律說「流動性不足」。那句話在最常見的情況下是錯的：
/// 池子有貨，是這個帳戶還沒通過身分驗證（或驗證過期、被凍結），hook 的 beforeSwap
/// 直接 revert。使用者看著一個明明有幾十噸的池子，被告知「這個數量吃不下」，
/// 然後去把數量從 1 噸改成 0.5 噸——再失敗一次。診斷錯了，指引就一定錯。
export type QuoteFail =
  /// 這個部署沒有 v4 池子（SKIP_V4）
  | { ok: false; reason: "no-pool" }
  /// 沒通過身分驗證、驗證過期，或被凍結
  | { ok: false; reason: "not-verified" }
  /// 超過該身分等級的單日交易上限
  | { ok: false; reason: "daily-limit" }
  /// 真的是池子吃不下。maxTonnes 是還吃得下多少（粗估，二分搜出來的）
  | { ok: false; reason: "liquidity"; maxTonnes: number };

export type QuoteOk = { ok: true; twd: number; perTonne: number; spot: number | null };
export type MarketQuote = QuoteOk | QuoteFail;

/// routerAbi 併上全站的自訂 error，viem 才解得開 hook 丟出來的東西；
/// 少了它，回來的只是一個四位元組的 selector，分不出是身分還是流動性。
const SWAP_ABI = [...routerAbi, ...errorAbi] as unknown as typeof routerAbi;

/// 單純跑一次模擬，成功回 BalanceDelta，失敗把錯誤丟出來。
async function simulateSwap(account: Address, kg: bigint, side: "buy" | "sell") {
  const d = deployment();
  const key = poolKey()!;
  const cct = kg * 10n ** 15n;
  const twdIsCurrency0 = key.currency0.toLowerCase() === d.settlementToken.toLowerCase();
  const zeroForOne = side === "buy" ? twdIsCurrency0 : !twdIsCurrency0;
  const amountSpecified = side === "buy" ? cct : -cct;

  // 暫時把餘額與授權撐大。mapping 的槽位由 keccak(key . slot) 算出來，
  // MockTWD 是單純的 ERC20：_balances 在槽 0、_allowances 在槽 1。
  const huge = `0x${(10n ** 30n).toString(16).padStart(64, "0")}` as Hex;
  const mapSlot = (slot: number, k: Address) =>
    keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [k, BigInt(slot)]));
  const token = side === "buy" ? d.settlementToken : d.cct;
  const overrides = [{
    address: token,
    stateDiff: [
      { slot: mapSlot(0, account), value: huge },
      {
        slot: keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [d.router, mapSlot(1, account)])),
        value: huge,
      },
    ],
  }];

  const { result } = await publicClient.simulateContract({
    address: d.router, abi: SWAP_ABI, functionName: "swap", account,
    args: [key, { zeroForOne, amountSpecified, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT + 1n : MAX_SQRT - 1n },
      0n, BigInt(Math.floor(Date.now() / 1000) + 600)],
    stateOverride: overrides,
  });
  const packed = BigInt(result as bigint);
  const amount0 = BigInt.asIntN(128, packed >> 128n);
  const amount1 = BigInt.asIntN(128, packed & ((1n << 128n) - 1n));
  return { amount0, amount1, twdIsCurrency0 };
}

/// 池子還吃得下幾噸。只在真的因為流動性失敗時才跑——十幾次 eth_call，
/// 換一句「最多還能買 X 噸」，比叫使用者自己一路往下猜數字划算。
///
/// 上界不能直接用「他輸入的數量」：有人輸入十萬噸、實際上限三十噸，
/// 十次二分從十萬噸只降到九十幾噸，結果會是 0——訊息裡就少了那個數字。
/// 先用 PoolManager 手上的 CCT 餘額把上界壓到物理極限（任何 swap 都不可能
/// 吐出比它更多），再二分。
async function maxFillableTonnes(account: Address, side: "buy" | "sell", failedKg: bigint): Promise<number> {
  const d = deployment();
  const held = await publicClient.readContract({
    address: side === "buy" ? d.cct : d.settlementToken, abi: erc20Abi,
    functionName: "balanceOf", args: [d.poolManager],
  }).catch(() => 0n) as bigint;
  // CCT 是 18 位小數、1 噸 = 1e18；kg 是 1e15
  const heldKg = side === "buy" ? held / 10n ** 15n : failedKg;
  let lo = 0n, hi = failedKg < heldKg ? failedKg : heldKg;
  if (hi <= 0n) return 0;
  for (let i = 0; i < 14 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    if (mid <= 0n) break;
    try { await simulateSwap(account, mid, side); lo = mid; } catch { hi = mid; }
  }
  return Number(lo) / 1000;
}

export async function quoteMarket(
  account: Address,
  kg: bigint,
  side: "buy" | "sell",
): Promise<MarketQuote> {
  const d = deployment();
  const key = poolKey();
  if (!key) return { ok: false, reason: "no-pool" }; // SKIP_V4 部署沒有池子
  // 先問身分，再問池子。這一個 eth_call 就把「最常見的失敗原因」跟
  // 「真的沒貨」分開了——而且它是**可以直接回答**的，不必從 revert 反推。
  const active = await publicClient.readContract({
    address: d.kycRegistry, abi: kycRegistryAbi, functionName: "isActive", args: [account],
  }).catch(() => false);
  if (!active) return { ok: false, reason: "not-verified" };

  try {
    // BalanceDelta 是 int128 amount0（高位）| int128 amount1（低位）
    const { amount0, amount1, twdIsCurrency0 } = await simulateSwap(account, kg, side);
    const twdRaw = twdIsCurrency0 ? amount0 : amount1;
    // 買進時 delta 是負的（錢出去），賣出時是正的
    const twd = Number(side === "buy" ? -twdRaw : twdRaw) / 1e6;
    const tonnes = Number(kg) / 1000;
    const spot = await poolSpotPricePerTonne().catch(() => null);
    return { ok: true, twd, perTonne: tonnes > 0 ? twd / tonnes : 0, spot };
  } catch (e) {
    // 身分已經排除了，剩下的常態是池子吃不下。單日上限另外認一下——
    // 目前部署沒有設上限（dailyLimit 預設 0 就不檢查），但設了之後這裡要說對話。
    if (/DailyLimitExceeded/.test(String(e))) return { ok: false, reason: "daily-limit" };
    return { ok: false, reason: "liquidity", maxTonnes: await maxFillableTonnes(account, side, kg) };
  }
}
