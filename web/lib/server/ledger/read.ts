import "server-only";
import type { Address } from "viem";
import { countryOfBatch, type Batch, type State } from "@/lib/ledger/engine";
import type { Event } from "@/lib/ledger/events";
import { tcerSerial } from "@/lib/tcer";
import type { Bid, Order } from "../market";
import type { Candle, Trade } from "../ticker";
import type { CountryStat } from "../by-country";
import { ANCHOR } from "../by-country";
import { computePortfolio, type Holding, type Movement, type Portfolio } from "../portfolio";
import { addWorkingDays, type Announcement, type Bulletin } from "../bulletin";
import { nextDisclosureDate, type Custody } from "../reserve";
import { tagOf } from "../mm";
import { eventHashCached, ledgerView, memoView, type View } from "./view";

/// 讀取面的帳本版本（設計 v4）。每一個函式都回傳**和鏈上版本相同的形狀**，
/// 所以畫面與 API 不必知道資料是從哪裡來的——切換只發生在 lib/server 的入口。
///
/// 金額單位與鏈上版本相同：結算幣最小單位（6 decimals）、數量是公斤、價格是最小單位／噸。
/// 以前的 `txHash` 欄位在這裡放的是**事件雜湊**：帳本裡的動作沒有鏈上交易，
/// 事件雜湊是它在帳本裡的唯一識別，也是包含證據要證明的那一片葉子。

const low = (a: string) => a.toLowerCase();

function hashOf(v: View, seq: bigint): string {
  const e = v.events[Number(seq) - 1];
  return e ? eventHashCached(e) : "";
}

type BatchInfo = { batch: Batch; project: string; methodology: string; location: string; country: string; scheme: string; domestic: boolean };
function batchInfo(s: State, batchId: bigint): BatchInfo | null {
  const b = s.batches.get(String(batchId));
  if (!b) return null;
  const p = s.projects.get(String(b.projectId));
  const country = countryOfBatch(s, batchId) ?? "";
  return {
    batch: b, project: p?.name ?? `專案 #${b.projectId}`, methodology: p?.methodology ?? "", location: p?.location ?? "",
    country, scheme: p?.scheme ?? s.jurisdictions.get(country)?.scheme ?? "", domestic: s.jurisdictions.get(country)?.domestic ?? country === "TW",
  };
}

// ── 掛單簿 ──

/// 依帳本 head 快取（見 view.ts 的 memoView）。回傳值是共用的，呼叫端不要改它
export function ledgerOrders(limit = 60): Order[] {
  return memoView(`orders:${limit}`, () => ledgerOrdersUncached(limit));
}
function ledgerOrdersUncached(limit = 60): Order[] {
  const { state } = ledgerView();
  return [...state.book.values()]
    .filter((o) => o.side === "sell" && o.remainingKg > 0n)
    .sort((a, b) => (a.pricePerTonne < b.pricePerTonne ? -1 : a.pricePerTonne > b.pricePerTonne ? 1 : a.seq < b.seq ? -1 : 1))
    .slice(0, limit)
    .map((o) => {
      const i = batchInfo(state, o.batchId);
      return {
        orderId: Number(o.seq), seller: o.account, batchId: Number(o.batchId), remainingKg: Number(o.remainingKg),
        pricePerTonne: o.pricePerTonne.toString(), minFillKg: Number(o.minFillKg),
        project: { name: i?.project ?? "", methodology: i?.methodology ?? "", location: i?.location ?? "" },
        vintageYear: i?.batch.vintageYear ?? 0, country: i?.country ?? "", scheme: i?.scheme ?? "", domestic: i?.domestic ?? false,
        tag: tagOf(o.account),
      };
    });
}

/// 依帳本 head 快取（見 view.ts 的 memoView）。回傳值是共用的，呼叫端不要改它
export function ledgerBids(limit = 60): Bid[] {
  return memoView(`bids:${limit}`, () => ledgerBidsUncached(limit));
}
function ledgerBidsUncached(limit = 60): Bid[] {
  const { state } = ledgerView();
  return [...state.book.values()]
    .filter((o) => o.side === "buy" && o.remainingKg > 0n)
    .sort((a, b) => (a.pricePerTonne > b.pricePerTonne ? -1 : a.pricePerTonne < b.pricePerTonne ? 1 : a.seq < b.seq ? -1 : 1))
    .slice(0, limit)
    .map((o) => ({
      bidId: Number(o.seq), buyer: o.account, country: o.country, remainingKg: Number(o.remainingKg),
      pricePerTonne: o.pricePerTonne.toString(), minFillKg: Number(o.minFillKg), tag: tagOf(o.account),
    }));
}

export const ledgerTradeFeeBps = (): number => Number(ledgerView().state.fees.tradeBps);

/// 帳戶的持有（**可動用的**，掛在簿子上的另計，和鏈上版本「錢包裡的」語意相同）。
export function ledgerHoldings(account: Address) {
  const { state } = ledgerView();
  const a = low(account);
  const batches = [...(state.credits.get(a) ?? new Map()).entries()]
    .map(([id, kg]) => {
      const i = batchInfo(state, BigInt(id));
      return { batchId: Number(id), kg: Number(kg), vintageYear: i?.batch.vintageYear ?? 0, project: i?.project ?? "", country: i?.country ?? "", scheme: i?.scheme ?? "" };
    })
    .filter((b) => b.kg > 0)
    .sort((x, y) => x.batchId - y.batchId);
  return { twd: (state.cash.get(a) ?? 0n).toString(), cct: "0", batches, pooledKgBatch1: "0" };
}

// ── 行情 ──

/// 依帳本 head 快取（見 view.ts 的 memoView）。回傳值是共用的，呼叫端不要改它
export function ledgerTrades(): Trade[] {
  return memoView("trades", () => ledgerTradesUncached());
}
function ledgerTradesUncached(): Trade[] {
  const v = ledgerView();
  return v.state.fills.map((f) => ({
    ts: Number(f.at), pricePerTonne: Number(f.pricePerTonne), kg: Number(f.amountKg), cost: Number(f.cost),
    txHash: hashOf(v, f.atSeq),
  }));
}

/// 依帳本 head 快取（見 view.ts 的 memoView）。回傳值是共用的，呼叫端不要改它
export function ledgerByCountry(rangeHours: number): { rangeHours: number; asOf: number; countries: CountryStat[] } {
  return memoView(`byCountry:${rangeHours}`, () => ledgerByCountryUncached(rangeHours));
}
function ledgerByCountryUncached(rangeHours: number): { rangeHours: number; asOf: number; countries: CountryStat[] } {
  const v = ledgerView();
  const s = v.state;
  const asOf = v.asOf;
  const since = asOf - rangeHours * 3600;
  type Acc = Omit<CountryStat, "country" | "name" | "scheme" | "registryName" | "enabled" | "lat" | "lon">;
  const blank = (): Acc => ({ issuedKg: 0, circulatingKg: 0, retiredKg: 0, tradedKg: 0, trades: 0, listedKg: 0, orders: 0, avgPricePerTonne: 0, priceSeries: [] });
  const acc = new Map<string, Acc>();
  const get = (c: string) => acc.get(c) ?? acc.set(c, blank()).get(c)!;

  for (const b of s.batches.values()) {
    const c = countryOfBatch(s, b.id);
    if (!c) continue;
    const x = get(c);
    x.issuedKg += Number(b.issuedKg);
    x.retiredKg += Number(b.retiredKg);
    x.circulatingKg += Number(b.issuedKg - b.retiredKg);
  }
  const BUCKETS = 26;
  const width = (rangeHours * 3600) / BUCKETS;
  const money = new Map<string, number>();
  const buckets = new Map<string, { kg: number; money: number }[]>();
  for (const f of s.fills) {
    const ts = Number(f.at);
    if (ts < since || !f.country) continue;
    const x = get(f.country);
    const kg = Number(f.amountKg);
    const m = (kg / 1000) * (Number(f.pricePerTonne) / 1e6);
    x.tradedKg += kg; x.trades += 1;
    money.set(f.country, (money.get(f.country) ?? 0) + m);
    const arr = buckets.get(f.country) ?? buckets.set(f.country, Array.from({ length: BUCKETS }, () => ({ kg: 0, money: 0 }))).get(f.country)!;
    const i = Math.min(BUCKETS - 1, Math.max(0, Math.floor((ts - since) / width)));
    arr[i].kg += kg; arr[i].money += m;
  }
  for (const [c, m] of money) { const x = get(c); if (x.tradedKg > 0) x.avgPricePerTonne = m / (x.tradedKg / 1000); }
  for (const [c, arr] of buckets) {
    get(c).priceSeries = arr.map((b, i) => ({ t: Math.round(since + (i + 0.5) * width), price: b.kg > 0 ? b.money / (b.kg / 1000) : 0 })).filter((p) => p.price > 0);
  }
  for (const o of s.book.values()) {
    if (o.side !== "sell" || !o.country) continue;
    const x = get(o.country);
    x.listedKg += Number(o.remainingKg); x.orders += 1;
  }
  const codes = [...new Set([...Object.keys(ANCHOR), ...s.jurisdictions.keys(), ...acc.keys()])];
  const countries: CountryStat[] = codes.map((c) => {
    const j = s.jurisdictions.get(c);
    const [lat, lon] = ANCHOR[c] ?? [0, 0];
    return { country: c, name: j?.name || c, scheme: j?.scheme || "—", registryName: j?.registryName || "", enabled: Boolean(j?.enabled), lat, lon, ...(acc.get(c) ?? blank()) };
  });
  countries.sort((a, b) => b.issuedKg - a.issuedKg || a.country.localeCompare(b.country));
  return { rangeHours, asOf, countries };
}

// ── 我的資產 ──

/// 依帳本 head 快取（見 view.ts 的 memoView）。回傳值是共用的，呼叫端不要改它
export function ledgerPortfolio(account: Address): Portfolio {
  return memoView(`portfolio:${account.toLowerCase()}`, () => ledgerPortfolioUncached(account));
}
function ledgerPortfolioUncached(account: Address): Portfolio {
  const v = ledgerView();
  const s = v.state;
  const me = low(account);
  const movements: Movement[] = [];
  let issuedKg = 0;
  for (const b of s.batches.values()) {
    const p = s.projects.get(String(b.projectId));
    if (!p || low(p.owner) !== me) continue;
    issuedKg += Number(b.issuedKg);
    movements.push({ ts: Number(b.issuedAt), kind: "issue", batchId: Number(b.id), kg: Number(b.issuedKg), pricePerTonne: null, cashDelta: 0, txHash: hashOf(v, b.atSeq) });
  }
  for (const f of s.fills) {
    const price = Number(f.pricePerTonne);
    if (low(f.buyer) === me) movements.push({ ts: Number(f.at), kind: "buy", batchId: Number(f.batchId), kg: Number(f.amountKg), pricePerTonne: price, cashDelta: -Number(f.cost), txHash: hashOf(v, f.atSeq) });
    if (low(f.seller) === me) movements.push({ ts: Number(f.at), kind: "sell", batchId: Number(f.batchId), kg: Number(f.amountKg), pricePerTonne: price, cashDelta: Number(f.cost - f.fee), txHash: hashOf(v, f.atSeq) });
  }
  for (const c of s.certificates.values()) {
    if (low(c.account) !== me) continue;
    movements.push({ ts: Number(c.retiredAt), kind: "retire", batchId: Number(c.batchId), kg: Number(c.amountKg), pricePerTonne: null, cashDelta: 0, txHash: hashOf(v, c.atSeq) });
  }
  // 持有：可動用＋掛在簿子上的（都還是他的）
  const kgBy = new Map<string, bigint>();
  for (const m of [s.credits.get(me), s.lockedCredits.get(me)]) for (const [id, kg] of m ?? []) kgBy.set(id, (kgBy.get(id) ?? 0n) + kg);
  const batches: Holding[] = [...kgBy.entries()].filter(([, kg]) => kg > 0n).map(([id, kg]) => {
    const i = batchInfo(s, BigInt(id));
    return { batchId: Number(id), project: i?.project ?? "", vintageYear: i?.batch.vintageYear ?? 0, kg: Number(kg), country: i?.country ?? "", scheme: i?.scheme ?? "" };
  }).sort((a, b) => a.batchId - b.batchId);
  const last = s.fills[s.fills.length - 1];
  return computePortfolio({
    twd: Number((s.cash.get(me) ?? 0n) + (s.lockedCash.get(me) ?? 0n)), cctKg: 0, batches, movements, issuedKg,
    marketPricePerTonne: last ? Number(last.pricePerTonne) : null,
  });
}

// ── 公告欄 ──

/// 依帳本 head 快取（見 view.ts 的 memoView）。回傳值是共用的，呼叫端不要改它
export function ledgerBulletin(): Bulletin {
  return memoView("bulletin", () => ledgerBulletinUncached());
}
function ledgerBulletinUncached(): Bulletin {
  const v = ledgerView();
  const s = v.state;
  const rows: Announcement[] = [];
  const counters = { issue: 0, list: 0, transfer: 0, retire: 0 };
  const no = (kind: Announcement["kind"], ts: number) => {
    counters[kind] += 1;
    const prefix = { issue: "ISS", list: "LST", transfer: "TRF", retire: "RET" }[kind];
    return `${prefix}-${new Date(ts * 1000).getUTCFullYear()}-${String(counters[kind]).padStart(6, "0")}`;
  };
  const byEvent = (seq: bigint) => ({ txHash: hashOf(v, seq), blockNumber: Number(seq) });

  for (const b of [...s.batches.values()].sort((x, y) => Number(x.atSeq - y.atSeq))) {
    const p = s.projects.get(String(b.projectId));
    const ts = Number(b.issuedAt);
    rows.push({
      no: no("issue", ts), kind: "issue", ts, batchId: Number(b.id), projectId: Number(b.projectId), amountKg: Number(b.issuedKg),
      to: p?.owner, country: countryOfBatch(s, b.id) ?? undefined,
      serial: tcerSerial({ projectId: Number(b.projectId), batchId: Number(b.id), monitoringEnd: Number(b.monitoringEnd), amountKg: Number(b.issuedKg) }),
      ...byEvent(b.atSeq),
    });
  }
  const sells = v.events.filter((e): e is Extract<Event, { kind: "place" }> => e.kind === "place" && e.side === "sell" && !v.rejected.has(String(e.seq)));
  for (const e of sells) {
    const ts = Number(e.at);
    rows.push({
      no: no("list", ts), kind: "list", ts, orderId: Number(e.seq), batchId: Number(e.batchId), amountKg: Number(e.amountKg),
      from: e.account, pricePerTonne: Number(e.pricePerTonne), country: countryOfBatch(s, e.batchId) ?? undefined, ...byEvent(e.seq),
    });
  }
  for (const f of s.fills) {
    const ts = Number(f.at);
    rows.push({
      no: no("transfer", ts), kind: "transfer", ts, orderId: Number(f.makerSeq), batchId: Number(f.batchId), amountKg: Number(f.amountKg),
      from: f.seller, to: f.buyer, costTwd: Number(f.cost), pricePerTonne: Number(f.pricePerTonne), country: f.country || undefined, ...byEvent(f.atSeq),
    });
  }
  for (const c of s.certificates.values()) {
    const ts = Number(c.retiredAt);
    rows.push({
      no: no("retire", ts), kind: "retire", ts, batchId: Number(c.batchId), certId: Number(c.id), amountKg: Number(c.amountKg),
      from: c.account, to: c.account, country: c.country, claimableFrom: addWorkingDays(ts, 5), ...byEvent(c.atSeq),
    });
  }
  rows.sort((a, b) => b.ts - a.ts || b.blockNumber - a.blockNumber);

  const issuedKg = [...s.batches.values()].reduce((x, b) => x + Number(b.issuedKg), 0);
  const retiredKg = [...s.batches.values()].reduce((x, b) => x + Number(b.retiredKg), 0);
  const transferredKg = s.fills.reduce((x, f) => x + Number(f.amountKg), 0);
  const p = new Map<string, { address: Address; issued: number; bought: number; sold: number; retired: number }>();
  const touch = (a?: Address) => { if (!a) return null; const k = low(a); if (!p.has(k)) p.set(k, { address: a, issued: 0, bought: 0, sold: 0, retired: 0 }); return p.get(k)!; };
  for (const b of s.batches.values()) { const r = touch(s.projects.get(String(b.projectId))?.owner); if (r) r.issued += Number(b.issuedKg); }
  for (const f of s.fills) { touch(f.buyer)!.bought += Number(f.amountKg); touch(f.seller)!.sold += Number(f.amountKg); }
  for (const c of s.certificates.values()) touch(c.account)!.retired += Number(c.amountKg);
  return {
    summary: {
      issuedKg, retiredKg, transferredKg, circulatingKg: issuedKg - retiredKg,
      projects: new Set([...s.batches.values()].map((b) => String(b.projectId))).size,
      participants: p.size, lastAnnouncedAt: rows[0]?.ts ?? null,
    },
    announcements: rows,
    participants: [...p.values()].sort((a, b) => b.issued + b.bought - (a.issued + a.bought)),
  };
}

/// 託管揭露：對帳報告與各國流通量都來自帳本；記帳 TWD 的發行量是鏈上的（營運方宣稱的信託餘額）。
/// 依帳本 head 快取（見 view.ts 的 memoView）。回傳值是共用的，呼叫端不要改它
export function ledgerCustody(tokenSupply: bigint): Custody {
  return memoView(`custody:${tokenSupply}`, () => ledgerCustodyUncached(tokenSupply));
}
function ledgerCustodyUncached(tokenSupply: bigint): Custody {
  const { state } = ledgerView();
  const live = new Map<string, number>();
  for (const b of state.batches.values()) {
    const c = countryOfBatch(state, b.id);
    if (c) live.set(c, (live.get(c) ?? 0) + Number(b.issuedKg - b.retiredKg));
  }
  const reports = [...state.reports.values()].sort((a, b) => Number(a.id - b.id));
  const r = reports[reports.length - 1];
  return {
    latest: r ? {
      reportId: Number(r.id), period: r.period, asOf: Number(r.asOf), publishedAt: Number(r.publishedAt), attestedAt: Number(r.attestedAt),
      status: r.status, auditorName: r.auditorName, note: r.note, documentHash: r.documentHash,
      credits: r.credits.map((c) => ({
        country: c.country, custodian: c.custodian, accountRef: c.accountRef, heldKg: Number(c.heldKg),
        reportedOnchainKg: Number(c.ledgerKg), liveOnchainKg: live.get(c.country) ?? 0, statementHash: c.statementHash,
      })),
      cash: { trustee: r.cash.trustee, accountRef: r.cash.accountRef, balance: r.cash.balance.toString(), tokenSupply: r.cash.tokenSupply.toString(), statementHash: r.cash.statementHash },
    } : null,
    periods: [...new Set(reports.map((x) => x.period))].sort((a, b) => a - b),
    live: [...state.jurisdictions.values()]
      .map((j) => ({ country: j.country, name: j.name, scheme: j.scheme, registryName: j.registryName, circulatingKg: live.get(j.country) ?? 0 }))
      .filter((j) => j.circulatingKg > 0 || j.country === "TW"),
    liveTokenSupply: tokenSupply.toString(),
    nextDisclosure: nextDisclosureDate(),
  };
}

/// 登錄簿的流通量（核發 − 註銷）。碳權不在鏈上，所以「池子裡實際有多少」在 v4 沒有鏈上數字可比；
/// 能比的是登錄簿流通量 vs 餘額樹總額——兩者應該相等，由重播保證。
export const ledgerCirculatingKg = (): bigint =>
  [...ledgerView().state.batches.values()].reduce((s, b) => s + b.issuedKg - b.retiredKg, 0n);

export type { Candle };
