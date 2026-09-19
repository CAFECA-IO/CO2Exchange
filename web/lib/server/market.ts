import "server-only";
import { encodeAbiParameters, keccak256, encodePacked, type Address } from "viem";
import { creditAbi, erc20Abi, listingAbi, poolAbi, poolManagerAbi, registryAbi } from "@/lib/abis";
import { deployment, publicClient } from "./chain";
import { hasV4 } from "@/lib/deployment";

export type Order = {
  orderId: number; seller: Address; batchId: number; remainingKg: number; pricePerTonne: string; minFillKg: number;
  project: { name: string; methodology: string; location: string }; vintageYear: number;
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
    return { batchId: Number(id), kg: Number(bal), vintageYear: b.vintageYear, project: p.name };
  }));
  const pooled = await publicClient.readContract({ address: d.carbonPool, abi: poolAbi, functionName: "pooledKg", args: [1n] }).catch(() => 0n);
  return { twd: twd.toString(), cct: cct.toString(), batches: batches.filter((b) => b.kg > 0), pooledKgBatch1: pooled.toString() };
}
