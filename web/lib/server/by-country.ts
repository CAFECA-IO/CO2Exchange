/// 各轄區的市場數據，全部由鏈上事件推導。
///
/// 首頁的地球畫的就是這份資料。地球負責「在哪裡、大概多少」，
/// 旁邊的清單負責「精確是多少」——球面上的柱子會因為透視與球面曲率而失真，
/// 靠近邊緣的那一根看起來一定比正對鏡頭的那一根短。
/// 所以量的比較放在清單的水平長條上，地球不負責讓人讀出數字。

import { deployment, publicClient } from "@/lib/server/chain";
import { EVENTS, listingAbi, registryAbi } from "@/lib/abis";
import { countryCode } from "@/lib/deployment";

const { batchIssued: ISSUED, creditRetired: RETIRED, filled: FILLED } = EVENTS;

/// 地球上放柱子的位置。取各國陸地的視覺重心，不是幾何形心——
/// 印尼的幾何形心會落在海上，澳洲的會落在無人的內陸，兩者都指不到人看得懂的地方。
const ANCHOR: Record<string, [number, number]> = {
  TW: [23.8, 121.0], JP: [36.2, 138.3], KR: [36.5, 127.8], TH: [15.2, 100.9],
  ID: [-2.5, 117.5], AU: [-25.0, 133.5], CN: [35.0, 104.0], IN: [22.5, 79.0],
  SG: [1.35, 103.82],
};

export type CountryStat = {
  country: string;
  name: string;
  scheme: string;
  registryName: string;
  enabled: boolean;
  lat: number;
  lon: number;
  /// 累計核發量（公斤）
  issuedKg: number;
  /// 目前鏈上流通量＝核發 − 註銷
  circulatingKg: number;
  /// 累計註銷量
  retiredKg: number;
  /// 區間內成交量與成交筆數
  tradedKg: number;
  trades: number;
  /// 區間內的成交均價（mTWD / 噸，以成交量加權）。沒有成交就是 0。
  ///
  /// 為什麼是加權平均而不是最後一筆：最後一筆可能是某個人買 0.1 噸留下的，
  /// 拿它代表一個轄區的價格，會被一筆小單帶著跑。
  avgPricePerTonne: number;
  /// 目前掛單簿上的數量與筆數
  listedKg: number;
  orders: number;
};

export async function byCountry(rangeHours = 24 * 365): Promise<{
  rangeHours: number;
  asOf: number;
  countries: CountryStat[];
}> {
  const d = deployment();
  const [issued, retired, filled, nextOrderId, head] = await Promise.all([
    publicClient.getLogs({ address: d.carbonCredit1155, event: ISSUED, fromBlock: 0n }),
    publicClient.getLogs({ address: d.carbonCredit1155, event: RETIRED, fromBlock: 0n }),
    publicClient.getLogs({ address: d.listing, event: FILLED, fromBlock: 0n }),
    publicClient.readContract({ address: d.listing, abi: listingAbi, functionName: "nextOrderId" }),
    publicClient.getBlock(),
  ]);

  // batchId → projectId，核發事件就帶著
  const batchProject = new Map<number, number>();
  for (const l of issued) batchProject.set(Number(l.args.batchId), Number(l.args.projectId));

  const projectIds = [...new Set(batchProject.values())];
  const projCountry = new Map<number, string>(
    await Promise.all(
      projectIds.map(async (pid) => {
        const p = await publicClient.readContract({
          address: d.carbonRegistry, abi: registryAbi, functionName: "projectOf", args: [BigInt(pid)],
        });
        return [pid, countryCode(p.country)] as [number, string];
      }),
    ),
  );
  const countryOfBatch = (b: number) => {
    const pid = batchProject.get(b);
    return pid == null ? undefined : projCountry.get(pid);
  };

  // 成交要經過 orderId → batchId；Filled 事件本身只帶 orderId。
  const filledOrderIds = [...new Set(filled.map((l) => Number(l.args.orderId)))];
  // 價格也從這裡拿。掛單的單價在成立之後不會變，所以就算這張單已經吃完、
  // 變成 inactive，orderOf 回來的 pricePerTonne 仍然是當時成交的價。
  const orderInfo = new Map<number, { batchId: number; pricePerTonne: bigint }>(
    await Promise.all(
      filledOrderIds.map(async (id) => {
        const o = await publicClient.readContract({
          address: d.listing, abi: listingAbi, functionName: "orderOf", args: [BigInt(id)],
        });
        return [id, { batchId: Number(o.batchId), pricePerTonne: o.pricePerTonne }] as
          [number, { batchId: number; pricePerTonne: bigint }];
      }),
    ),
  );

  // 成交要依時間篩選，所以得知道每個區塊的時間。同一個區塊只問一次。
  const blockTimes = new Map<bigint, number>();
  await Promise.all(
    [...new Set(filled.map((l) => l.blockNumber!))].map(async (bn) => {
      const b = await publicClient.getBlock({ blockNumber: bn });
      blockTimes.set(bn, Number(b.timestamp));
    }),
  );

  const asOf = Number(head.timestamp);
  const since = asOf - rangeHours * 3600;

  const blank = (): Omit<CountryStat, "country" | "name" | "scheme" | "registryName" | "enabled" | "lat" | "lon"> => ({
    issuedKg: 0, circulatingKg: 0, retiredKg: 0, tradedKg: 0, trades: 0, listedKg: 0, orders: 0,
    avgPricePerTonne: 0,
  });
  const acc = new Map<string, ReturnType<typeof blank>>();
  const get = (c: string) => {
    let v = acc.get(c);
    if (!v) acc.set(c, (v = blank()));
    return v;
  };

  for (const l of issued) {
    const c = projCountry.get(Number(l.args.projectId));
    if (!c) continue;
    const v = get(c);
    v.issuedKg += Number(l.args.amountKg);
    v.circulatingKg += Number(l.args.amountKg);
  }
  for (const l of retired) {
    const c = countryOfBatch(Number(l.args.batchId));
    if (!c) continue;
    const v = get(c);
    v.retiredKg += Number(l.args.amountKg);
    v.circulatingKg -= Number(l.args.amountKg);
  }
  // 成交金額另外累加，最後再除以成交量得到加權均價——
  // 不要把「每一筆的單價」平均起來，那會讓 0.1 噸的單跟 500 噸的單一樣重。
  const notional = new Map<string, number>();
  for (const l of filled) {
    const t = blockTimes.get(l.blockNumber!) ?? 0;
    if (t < since) continue;
    const info = orderInfo.get(Number(l.args.orderId));
    const c = info == null ? undefined : countryOfBatch(info.batchId);
    if (!c || !info) continue;
    const v = get(c);
    const kg = Number(l.args.amountKg);
    v.tradedKg += kg;
    v.trades += 1;
    notional.set(c, (notional.get(c) ?? 0) + (kg / 1000) * (Number(info.pricePerTonne) / 1e6));
  }
  for (const [c, money] of notional) {
    const v = get(c);
    if (v.tradedKg > 0) v.avgPricePerTonne = money / (v.tradedKg / 1000);
  }

  // 掛單簿現況：逐筆讀，數量不大（示範規模）
  const ids = Array.from({ length: Number(nextOrderId) - 1 }, (_, i) => BigInt(i + 1));
  const orders = await Promise.all(
    ids.map((id) =>
      publicClient.readContract({ address: d.listing, abi: listingAbi, functionName: "orderOf", args: [id] }),
    ),
  );
  for (const o of orders) {
    if (!o.active || o.remainingKg === 0n) continue;
    const c = countryOfBatch(Number(o.batchId));
    if (!c) continue;
    const v = get(c);
    v.listedKg += Number(o.remainingKg);
    v.orders += 1;
  }

  // 轄區名稱與開放狀態一律讀鏈上的 jurisdiction，不在前端寫死——
  // 主權角色關掉某一國的時候，首頁要跟著變，不必改程式。
  const codes = [...new Set([...Object.keys(ANCHOR), ...acc.keys()])];
  const countries = await Promise.all(
    codes.map(async (c) => {
      const bytes2 = (`0x${Buffer.from(c, "utf8").toString("hex")}`) as `0x${string}`;
      const j = await publicClient
        .readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "jurisdictionOf", args: [bytes2] })
        .catch(() => null);
      const [lat, lon] = ANCHOR[c] ?? [0, 0];
      return {
        country: c,
        name: j?.name || c,
        scheme: j?.scheme || "—",
        registryName: j?.registryName || "",
        enabled: Boolean(j?.enabled),
        lat, lon,
        ...(acc.get(c) ?? blank()),
      };
    }),
  );

  countries.sort((a, b) => b.issuedKg - a.issuedKg || a.country.localeCompare(b.country));
  return { rangeHours, asOf, countries };
}
