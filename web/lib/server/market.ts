import "server-only";
import { encodeAbiParameters, keccak256, encodePacked, type Address } from "viem";
import { creditAbi, erc20Abi, listingAbi, poolAbi, poolManagerAbi, registryAbi } from "@/lib/abis";
import { deployment, publicClient } from "./chain";

export type Order = {
  orderId: number; seller: Address; batchId: number; remainingKg: number; pricePerTonne: string; minFillKg: number;
  project: { name: string; methodology: string; location: string }; vintageYear: number;
};

export function poolKey() {
  const d = deployment();
  const [c0, c1] = d.cct.toLowerCase() < d.settlementToken.toLowerCase() ? [d.cct, d.settlementToken] : [d.settlementToken, d.cct];
  return { currency0: c0, currency1: c1, fee: d.poolFee, tickSpacing: d.tickSpacing, hooks: d.hook } as const;
}

export function poolId() {
  const k = poolKey();
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
  ));
}

/// v4 現貨價：sqrtPriceX96 → mTWD / 噸（6 decimals），不含手續費與滑價
export async function poolSpotPricePerTonne(): Promise<number | null> {
  const d = deployment();
  const slot = keccak256(encodePacked(["bytes32", "bytes32"], [poolId(), `0x${(6).toString(16).padStart(64, "0")}`]));
  const raw = await publicClient.readContract({ address: d.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [slot] });
  const sqrtP = BigInt(raw) & ((1n << 160n) - 1n);
  if (sqrtP === 0n) return null;
  // price1/0 = (sqrtP / 2^96)^2 ；用 1e18 精度做整數運算
  const priceX = (sqrtP * sqrtP * 10n ** 18n) >> 192n; // amount1 per amount0 * 1e18
  const twdIs0 = poolKey().currency0.toLowerCase() === d.settlementToken.toLowerCase();
  // 1 噸 = 1e18 CCT raw；TWD raw(6 dec) / 噸：
  //   CCT 是 currency0 → price = TWD/CCT → perTonne = priceX
  //   TWD 是 currency0 → price = CCT/TWD → perTonne = 1e36 / priceX
  const perTonne6 = twdIs0 ? (10n ** 36n) / priceX : priceX;
  return Number(perTonne6) / 1e6;
}

export async function listOrders(): Promise<Order[]> {
  const d = deployment();
  const next = await publicClient.readContract({ address: d.listing, abi: listingAbi, functionName: "nextOrderId" });
  const out: Order[] = [];
  for (let i = 1n; i < next; i++) {
    const o = await publicClient.readContract({ address: d.listing, abi: listingAbi, functionName: "orderOf", args: [i] });
    if (!o.active) continue;
    const b = await publicClient.readContract({ address: d.carbonCredit1155, abi: creditAbi, functionName: "batchOf", args: [o.batchId] });
    const p = await publicClient.readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "projectOf", args: [b.projectId] });
    out.push({
      orderId: Number(i), seller: o.seller, batchId: Number(o.batchId), remainingKg: Number(o.remainingKg),
      pricePerTonne: o.pricePerTonne.toString(), minFillKg: Number(o.minFillKg),
      project: { name: p.name, methodology: p.methodology, location: p.location }, vintageYear: b.vintageYear,
    });
  }
  return out;
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
