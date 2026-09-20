import "server-only";
import { encodeAbiParameters, keccak256, encodePacked, type Address, type Hex } from "viem";
import { creditAbi, erc20Abi, listingAbi, poolAbi, poolManagerAbi, registryAbi, routerAbi } from "@/lib/abis";
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
export async function quoteMarket(
  account: Address,
  kg: bigint,
  side: "buy" | "sell",
): Promise<{ twd: number; perTonne: number; spot: number | null } | null> {
  const d = deployment();
  const key = poolKey();
  if (!key) return null; // SKIP_V4 部署沒有池子
  const cct = kg * 10n ** 15n;
  const twdIsCurrency0 = key.currency0.toLowerCase() === d.settlementToken.toLowerCase();
  // 買 = 精準輸出（要拿到正好這麼多 CCT）；賣 = 精準輸入（正好投入這麼多 CCT）
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

  try {
    const { result } = await publicClient.simulateContract({
      address: d.router, abi: routerAbi, functionName: "swap", account,
      args: [key, { zeroForOne, amountSpecified, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT + 1n : MAX_SQRT - 1n },
        0n, BigInt(Math.floor(Date.now() / 1000) + 600)],
      stateOverride: overrides,
    });
    // BalanceDelta 是 int128 amount0（高位）| int128 amount1（低位）
    const packed = BigInt(result as bigint);
    const amount0 = BigInt.asIntN(128, packed >> 128n);
    const amount1 = BigInt.asIntN(128, packed & ((1n << 128n) - 1n));
    const twdRaw = twdIsCurrency0 ? amount0 : amount1;
    // 買進時 delta 是負的（錢出去），賣出時是正的
    const twd = Number(side === "buy" ? -twdRaw : twdRaw) / 1e6;
    const tonnes = Number(kg) / 1000;
    const spot = await poolSpotPricePerTonne().catch(() => null);
    return { twd, perTonne: tonnes > 0 ? twd / tonnes : 0, spot };
  } catch {
    // 流動性不足、或這個帳戶過不了 hook 的身分檢查
    return null;
  }
}
