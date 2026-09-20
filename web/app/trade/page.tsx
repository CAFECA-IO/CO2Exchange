"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useReload } from "@/lib/client/useReload";
import { encodeFunctionData, type Address } from "viem";
import { useAccount } from "@/components/AccountProvider";
import { AccountGate } from "@/components/AccountGate";
import { AgreementCheck, useAgreementGate } from "@/components/AgreementGate";
import { Button, Card, Field, Notice, fmtKg, fmtTwd, inputCls } from "@/components/ui";
import { erc1155ApprovalAbi, erc20Abi, listingAbi, listingWriteAbi, poolAbi, routerAbi } from "@/lib/abis";
import { flagOf } from "@/lib/deployment";
import { signAndRelay, type Call } from "@/lib/client/passkey";

/// 交易頁：買進與賣出同一頁，各自再分限價與市價。
///
/// 使用者只處理兩件事——**數量**與**單價**。限價的單價是掛單簿上的價（買方不能改）
/// 或自己開的價（賣方）；市價沒有單價要填，成交價由當下的市場決定，所以只剩數量。
///
/// 市價買進在同一筆簽章裡做完兩件事：以結算幣換到額度，然後**立刻拆解成具體批次**。
/// 使用者的資產列表裡不會出現任何中介代幣——他買的是碳權，看到的就該是一批一批的碳權，
/// 帶著專案、年份與核發國。中介代幣是實作細節，不是使用者該認識的東西。
///
/// 國別不是裝飾。國外額度在臺灣只能用於扣除碳費（上限 5%，且高碳洩漏風險事業不得使用）
/// 與自願性碳中和，不能用於環評增量抵換——所以掛單簿上每一筆都標明核發國。

type Order = {
  orderId: number; seller: string; batchId: number; remainingKg: number; pricePerTonne: string;
  minFillKg: number; project: { name: string; methodology: string; location: string }; vintageYear: number;
  country: string; scheme: string; domestic: boolean;
};
type Batch = { batchId: number; kg: number; vintageYear: number; project: string; country: string; scheme: string };
type Market = {
  orders: Order[]; spotPricePerTonne: number | null; listingFeeBps: number;
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address } | null;
  holdings: { twd: string; cct: string; batches: Batch[] } | null;
};

const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;
/// 市價單的價格保護：成交價與參考價相差超過這個比例就讓交易失敗，而不是默默成交在爛價格上。
const SLIPPAGE = 0.05;

function oneYearLater() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}
const defaultSell = (kg: number) => ({ tonnes: String(kg / 1000), price: "800", minFill: "0.1", usageDeadline: oneYearLater() });
const twd2 = (v: number) => v.toLocaleString("zh-TW", { maximumFractionDigits: 2 });
/// 市價單的有效期限：十分鐘。寫成元件外的函式，免得 lint 把 Date.now 當成渲染期的副作用。
const deadline10m = () => BigInt(Math.floor(Date.now() / 1000) + 600);

/// 國別標籤。國外額度一律標出來；國內的也標，免得「沒標＝國內」變成要背的規則。
function CountryTag({ code, scheme, className = "" }: { code: string; scheme?: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded bg-ink-600 px-1.5 py-0.5 text-[10px] text-ink-200 ${className}`}>
      <span aria-hidden>{flagOf(code)}</span>
      {code}
      {scheme && <span className="text-ink-300">{scheme}</span>}
    </span>
  );
}

export default function TradePage() {
  const { credential, config, userId, tier } = useAccount();
  const [m, setM] = useState<Market | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [mode, setMode] = useState<"limit" | "market">("limit");
  const [selected, setSelected] = useState<Order | null>(null);
  const [qtyKg, setQtyKg] = useState("1000");
  const [marketTonnes, setMarketTonnes] = useState("1");
  /// 市價的**實際**成本，跟鏈要，不是用現貨價乘一乘。
  /// 池子是曲線，精準輸出的成交價是沿路的平均價；這個 demo 池薄到
  /// 買 5 噸就比現貨貴兩成、20 噸貴一倍多。用現貨估出來的「最高支付」
  /// 既不是使用者會付的錢，照它授權還會讓交易必定失敗。
  // 報價連同「它是對哪一組輸入報的」一起存。這樣切換模式或改數量時，
  // 舊的報價自然就對不上而失效，不必在 effect 裡同步 setState 清空它
  //（那會觸發連鎖 render，而且 hooks 的順序也不允許放在早退之後）。
  type Quote = { twd: number; perTonne: number; spot: number | null } | "none";
  const [quoted, setQuoted] = useState<{ key: string; value: Quote } | null>(null);
  const [filter, setFilter] = useState<string>("ALL");
  const [advanced, setAdvanced] = useState(false);
  const [sellBatch, setSellBatch] = useState<number | null>(null);
  const [sellForm, setSellForm] = useState<Record<number, { tonnes: string; price: string; minFill: string; usageDeadline: string }>>({});
  const [naturalAck, setNaturalAck] = useState(false);
  const [confirm, setConfirm] = useState<null | "buy" | "sell" | "mbuy" | "msell">(null);

  const [reloadKey, reload] = useReload();
  const buyGate = useAgreementGate(credential?.address, ["platform-terms", "trade-agreement"]);
  const sellGate = useAgreementGate(credential?.address, ["platform-terms", "service-fee", "trade-agreement"]);

  useEffect(() => {
    let ignore = false;
    (async () => {
      const r = await fetch(`/api/market${credential ? `?account=${credential.address}` : ""}`);
      if (!ignore && r.ok) setM(await r.json());
    })();
    return () => { ignore = true; };
  }, [credential, reloadKey]);

  // 市價報價：使用者打字時延遲一下再問，不要每按一鍵就打一次鏈。
  const quoteKey = side === "buy" && mode === "market" && credential && Number(marketTonnes) > 0
    ? `${credential.address}:${Math.round(Number(marketTonnes) * 1000)}` : "";
  useEffect(() => {
    if (!quoteKey) return;
    const [address, kg] = quoteKey.split(":");
    let ignore = false;
    const id = setTimeout(async () => {
      try {
        const r = await fetch(`/api/market/quote?account=${address}&kg=${kg}&side=buy`);
        const j = await r.json();
        if (!ignore) setQuoted({ key: quoteKey, value: j.unavailable ? "none" : j });
      } catch { if (!ignore) setQuoted({ key: quoteKey, value: "none" }); }
    }, 350);
    return () => { ignore = true; clearTimeout(id); };
  }, [quoteKey]);
  const quote: Quote | null = quoted && quoted.key === quoteKey ? quoted.value : null;

  if (!userId || !credential || !config) return <AccountGate />;
  const d = config.deployment;

  async function relay(label: string, calls: Call[], after?: () => Promise<unknown>) {
    setBusy(label); setMsg(null); setConfirm(null);
    try {
      const r = await signAndRelay(config!.rpcUrl, credential!, calls);
      if (after) await after();
      setMsg({ kind: "ok", text: `${label}完成 · tx ${r.txHash.slice(0, 10)}… · gas ${Number(r.gasUsed).toLocaleString()}（平台代付）` });
      reload();
    } catch (e) {
      console.error("relay failed", e);
      setMsg({ kind: "error", text: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    } finally { setBusy(null); }
  }

  async function faucet() {
    setBusy("領取"); setMsg(null);
    try { await fetch("/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: credential!.address }) }); reload(); }
    finally { setBusy(null); }
  }

  function doBuy() {
    if (!selected) return;
    const kg = BigInt(Math.min(selected.remainingKg, Math.max(1, Math.round(Number(qtyKg)))));
    const cost = (kg * BigInt(selected.pricePerTonne)) / 1000n;
    relay(`購買 ${fmtKg(Number(kg))}`, [
      { target: d.settlementToken, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.listing, cost] }) },
      { target: d.listing, value: 0n, data: encodeFunctionData({ abi: listingAbi, functionName: "buy", args: [BigInt(selected.orderId), kg] }) },
    ]);
  }

  function doSell() {
    const b = sb;
    if (!b) return;
    const f = sellForm[b.batchId] ?? defaultSell(b.kg);
    const kg = BigInt(Math.min(b.kg, Math.max(1, Math.round(Number(f.tonnes) * 1000))));
    relay(`上架批次 #${b.batchId} ${fmtKg(Number(kg))}`, [
      { target: d.carbonCredit1155, value: 0n, data: encodeFunctionData({ abi: erc1155ApprovalAbi, functionName: "setApprovalForAll", args: [d.listing, true] }) },
      { target: d.listing, value: 0n, data: encodeFunctionData({ abi: listingWriteAbi, functionName: "list", args: [
        BigInt(b.batchId), kg, BigInt(Math.round(Number(f.price) * 1e6)), BigInt(Math.max(0, Math.round(Number(f.minFill) * 1000))),
      ] }) },
    ], () => fetch("/api/listing-meta", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ batchId: b.batchId, seller: credential!.address, usageDeadline: f.usageDeadline, amountKg: Number(kg) }),
    }));
  }

  /// 市價買進：一筆簽章做完「換到額度」與「拆解成批次」。
  /// 用精準輸出（exact output）而不是精準輸入，是為了讓拆解的數量在簽章之前就是確定的——
  /// 否則換到多少得等交易上鏈才知道，拆解就得再簽一次。
  function doMarketBuy() {
    if (!m?.poolKey || !m.spotPricePerTonne) return;
    const tonnes = Number(marketTonnes);
    const kg = BigInt(Math.round(tonnes * 1000));
    const cctOut = kg * 10n ** 15n;
    // 授權金額**從報價來**。原本是「現貨 × 數量 × 1.05」——那不是成交價，
    // 池子薄的時候差兩成以上，於是授權必定不夠，交易必定失敗。
    // 報價是對當下池況模擬出來的實際金額，再加一點緩衝吸收這段期間的價格變動。
    const quoted = typeof quote === "object" && quote ? quote.twd : tonnes * m.spotPricePerTonne;
    const maxSpend = BigInt(Math.ceil(quoted * (1 + SLIPPAGE) * 1e6));
    const zeroForOne = m.poolKey.currency0.toLowerCase() === d.settlementToken.toLowerCase();
    relay(`市價買進 ${fmtKg(Number(kg))}`, [
      { target: d.settlementToken, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.router, maxSpend] }) },
      { target: d.router, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "swap", args: [
        // 價格上限的方向只看交易方向，與精準輸入／輸出無關：
        // zeroForOne 時價格往下走，限制要放在下界。寫反了會直接 revert（而且錯誤訊息完全看不出原因）。
        m.poolKey, { zeroForOne, amountSpecified: cctOut, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT + 1n : MAX_SQRT - 1n },
        0n, deadline10m() ] }) },
      // 立刻拆解成具體批次：使用者的持有清單裡只會有碳權批次，沒有中介代幣
      { target: d.carbonPool, value: 0n, data: encodeFunctionData({ abi: poolAbi, functionName: "redeem", args: [kg] }) },
    ]);
  }

  /// 市價賣出：把持有的批次即時換回結算幣。
  function doMarketSell() {
    const b = sb;
    if (!b || !m?.poolKey || !m.spotPricePerTonne) return;
    const f = sellForm[b.batchId] ?? defaultSell(b.kg);
    const kg = BigInt(Math.min(b.kg, Math.max(1, Math.round(Number(f.tonnes) * 1000))));
    const cctIn = kg * 10n ** 15n;
    const minOut = BigInt(Math.floor((Number(kg) / 1000) * m.spotPricePerTonne * (1 - SLIPPAGE) * 1e6));
    const zeroForOne = m.poolKey.currency0.toLowerCase() === d.cct.toLowerCase();
    relay(`市價賣出 ${fmtKg(Number(kg))}`, [
      { target: d.carbonCredit1155, value: 0n, data: encodeFunctionData({ abi: erc1155ApprovalAbi, functionName: "setApprovalForAll", args: [d.carbonPool, true] }) },
      { target: d.carbonPool, value: 0n, data: encodeFunctionData({ abi: poolAbi, functionName: "deposit", args: [BigInt(b.batchId), kg] }) },
      { target: d.cct, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.router, cctIn] }) },
      { target: d.router, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "swap", args: [
        m.poolKey, { zeroForOne, amountSpecified: -cctIn, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT + 1n : MAX_SQRT - 1n },
        minOut, deadline10m() ] }) },
    ]);
  }

  function cancelOrder(o: Order) {
    relay(`取消掛單 #${o.orderId}`, [
      { target: d.listing, value: 0n, data: encodeFunctionData({ abi: listingWriteAbi, functionName: "cancel", args: [BigInt(o.orderId)] }) },
    ]);
  }

  const h = m?.holdings;
  const myBatches = h?.batches ?? [];
  const allOrders = m?.orders ?? [];
  const countries = [...new Set(allOrders.map((o) => o.country))];
  const orders = filter === "ALL" ? allOrders : allOrders.filter((o) => o.country === filter);
  const myOrders = allOrders.filter((o) => o.seller?.toLowerCase() === credential.address.toLowerCase());
  const maxDepthKg = Math.max(1, ...orders.map((o) => o.remainingKg));
  const buyCost = selected ? (Number(qtyKg || 0) * Number(selected.pricePerTonne)) / 1000 / 1e6 : 0;
  const balance = h ? Number(h.twd) / 1e6 : 0;
  const notEnough = buyCost > balance;
  const spot = m?.spotPricePerTonne ?? null;
  const hasMarket = !!m?.poolKey && !!spot;

  const sb = myBatches.find((x) => x.batchId === sellBatch) ?? myBatches[0];
  const sf = sb ? (sellForm[sb.batchId] ?? defaultSell(sb.kg)) : null;
  const setSf = (patch: Partial<NonNullable<typeof sf>>) => sb && sf && setSellForm({ ...sellForm, [sb.batchId]: { ...sf, ...patch } });
  const sellProceeds = sf ? Number(sf.tonnes) * Number(sf.price) : 0;
  const sellFee = (sellProceeds * (m?.listingFeeBps ?? 0)) / 10_000;


  const mBuyCost = typeof quote === "object" && quote ? quote.twd : spot ? Number(marketTonnes) * spot : 0;
  const impact = typeof quote === "object" && quote && quote.spot ? quote.perTonne / quote.spot - 1 : null;
  const mSellProceeds = sf && spot ? Number(sf.tonnes) * spot : 0;

  const buyReady = !!selected && !!qtyKg && Number(qtyKg) >= (selected.minFillKg || 1) && !notEnough;
  const sellReady = !!sb && !!sf && Number(sf.tonnes) > 0 && Number(sf.price) > 0 && Number(sf.tonnes) * 1000 <= sb.kg;
  // 報不出價就不讓送出。讓使用者按下去撞 revert，等於把「流動性不足」
  // 這個本來就知道的事實，包裝成一個看不懂的錯誤丟回他臉上。
  const mBuyReady = hasMarket && Number(marketTonnes) > 0 && quote !== "none"
    && typeof quote === "object" && quote !== null && mBuyCost <= balance;
  const mSellReady = hasMarket && !!sb && !!sf && sb.country === "TW" && Number(sf.tonnes) > 0 && Number(sf.tonnes) * 1000 <= sb.kg;

  return (
    <div className="space-y-5">
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[--radius-card] border border-ink-500 bg-ink-700 px-4 py-3 text-sm">
        <span className="text-ink-300">可用現金</span>
        <b className="tnum text-ink-50" data-testid="twd">{h ? fmtTwd(h.twd) : "—"} mTWD</b>
        <span className="text-ink-300">持有碳權</span>
        <b className="tnum text-ink-50" data-testid="batches">
          {myBatches.length ? myBatches.map((b) => `#${b.batchId} ${fmtKg(b.kg)}`).join("、") : "—"}
        </b>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/portfolio" className="text-xs text-tide underline">我的資產</Link>
          <Button variant="secondary" onClick={faucet} disabled={!!busy}>領取測試用 mTWD</Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        {/* ── 掛單簿 ───────────────────────────── */}
        <Card
          title="掛單簿"
          action={<span className="text-xs text-ink-300">賣單，由最佳價排起</span>}
        >
          {countries.length > 1 && (
            <div className="mb-2 flex flex-wrap gap-1">
              <button
                onClick={() => setFilter("ALL")}
                className={`rounded-full border px-2.5 py-1 text-xs transition ${filter === "ALL" ? "border-tide bg-tide/10 text-tide" : "border-ink-500 text-ink-300 hover:text-ink-50"}`}
              >全部 {allOrders.length}</button>
              {countries.map((c) => (
                <button
                  key={c}
                  data-testid={`filter-${c}`}
                  onClick={() => setFilter(c)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition ${filter === c ? "border-tide bg-tide/10 text-tide" : "border-ink-500 text-ink-300 hover:text-ink-50"}`}
                >
                  <span aria-hidden className="mr-1">{flagOf(c)}</span>{c} {allOrders.filter((o) => o.country === c).length}
                </button>
              ))}
            </div>
          )}
          {!m ? <p className="text-sm text-ink-300">讀取中…</p> : orders.length === 0 ? (
            <p className="text-sm text-ink-300">這個條件下沒有掛單。</p>
          ) : (
            <div>
              <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 border-b border-ink-500 pb-1.5 text-[11px] uppercase tracking-wider text-ink-300">
                <span>專案 / 批次</span><span className="text-right">數量</span><span className="text-right">價格 / 噸</span>
              </div>
              <ul className="max-h-[420px] divide-y divide-ink-500 overflow-auto">
                {orders.map((o) => {
                  const depth = Math.min(100, (o.remainingKg / maxDepthKg) * 100);
                  const sel = selected?.orderId === o.orderId;
                  const mine = o.seller?.toLowerCase() === credential.address.toLowerCase();
                  return (
                    <li key={o.orderId}>
                      <button
                        onClick={() => { setSide("buy"); setMode("limit"); setSelected(o); setQtyKg(String(Math.min(1000, o.remainingKg))); }}
                        className={`relative grid w-full grid-cols-[1fr_auto_auto] gap-x-4 px-1 py-2 text-left text-sm transition hover:bg-ink-600 ${sel ? "bg-ink-600" : ""}`}
                        aria-pressed={sel}
                      >
                        <span className="pointer-events-none absolute inset-y-0 right-0 bg-down/12" style={{ width: `${depth}%` }} aria-hidden />
                        <span className="relative min-w-0">
                          <span className="flex items-center gap-1.5 truncate text-ink-50">
                            <CountryTag code={o.country} />
                            {o.project.name}
                            {mine && <span className="rounded bg-ink-600 px-1.5 py-0.5 text-[10px] text-ink-300">我的掛單</span>}
                          </span>
                          <span className="block truncate text-xs text-ink-300">{o.scheme} · {o.vintageYear} · 批次 #{o.batchId}</span>
                        </span>
                        <span className="tnum relative self-center text-right text-ink-200">{fmtKg(o.remainingKg)}</span>
                        <span className="tnum relative self-center text-right font-medium text-down">{fmtTwd(o.pricePerTonne)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-xs text-ink-300">平台手續費 {(m.listingFeeBps ?? 0) / 100}%，由賣方承擔。國外額度在臺灣的可用途徑與國內不同，下單前會再提示一次。</p>
            </div>
          )}
        </Card>

        {/* ── 下單面板 ─────────────────────────── */}
        <Card
          title="下單"
          action={
            <div className="flex gap-1 rounded-[--radius-ctl] border border-ink-500 p-0.5 text-sm">
              <button
                data-testid="tab-buy"
                onClick={() => setSide("buy")}
                className={`rounded px-3 py-1 transition ${side === "buy" ? "bg-up/15 font-medium text-up" : "text-ink-300 hover:text-ink-50"}`}
              >買進</button>
              <button
                data-testid="tab-sell"
                onClick={() => setSide("sell")}
                className={`rounded px-3 py-1 transition ${side === "sell" ? "bg-down/15 font-medium text-down" : "text-ink-300 hover:text-ink-50"}`}
              >賣出</button>
            </div>
          }
        >
          <div className="mb-3 flex gap-1 rounded-[--radius-ctl] bg-ink-800 p-0.5 text-xs">
            <button
              data-testid="mode-limit"
              onClick={() => setMode("limit")}
              className={`flex-1 rounded px-2 py-1.5 transition ${mode === "limit" ? "bg-ink-600 font-medium text-ink-50" : "text-ink-300 hover:text-ink-50"}`}
            >限價（指定專案與價格）</button>
            <button
              data-testid="mode-market"
              onClick={() => setMode("market")}
              disabled={!hasMarket}
              className={`flex-1 rounded px-2 py-1.5 transition disabled:opacity-40 ${mode === "market" ? "bg-ink-600 font-medium text-ink-50" : "text-ink-300 hover:text-ink-50"}`}
            >市價（即時成交）</button>
          </div>

          {/* 買進 · 限價 */}
          {side === "buy" && mode === "limit" && (
            !selected ? (
              <p className="text-sm text-ink-300">從左邊的掛單簿點一筆來下單。</p>
            ) : (
              <div className="space-y-3">
                <div className="rounded-[--radius-ctl] border border-ink-500 bg-ink-800 p-3 text-sm">
                  <div className="flex items-center gap-1.5 text-ink-50"><CountryTag code={selected.country} scheme={selected.scheme} />{selected.project.name}</div>
                  <div className="mt-0.5 text-xs text-ink-300">
                    {selected.project.location} · {selected.vintageYear} 年份 · 批次 #{selected.batchId} · 可買 {fmtKg(selected.remainingKg)}
                  </div>
                </div>

                <Field label={`數量（噸，最少 ${((selected.minFillKg || 1) / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 3 })}）`}>
                  <input
                    className={inputCls} type="number" step="0.001"
                    min={(selected.minFillKg || 1) / 1000} max={selected.remainingKg / 1000}
                    value={Number(qtyKg) / 1000}
                    onChange={(e) => setQtyKg(String(Math.round(Number(e.target.value) * 1000)))}
                  />
                </Field>
                <Field label="單價 mTWD / 噸（賣方定價，不可更改）">
                  <input className={`${inputCls} text-ink-300`} value={fmtTwd(selected.pricePerTonne)} readOnly />
                </Field>
                <div className="flex gap-1">
                  {[1, 5, 10].map((t) => (
                    <button key={t} onClick={() => setQtyKg(String(Math.min(selected.remainingKg, t * 1000)))}
                      className="flex-1 rounded border border-ink-500 py-1 text-xs text-ink-300 transition hover:border-tide/60 hover:text-ink-50">{t} 噸</button>
                  ))}
                  <button onClick={() => setQtyKg(String(selected.remainingKg))}
                    className="flex-1 rounded border border-ink-500 py-1 text-xs text-ink-300 transition hover:border-tide/60 hover:text-ink-50">全部</button>
                </div>

                <dl className="space-y-1 border-t border-ink-500 pt-3 text-sm">
                  <div className="flex justify-between"><dt className="text-ink-300">應付金額</dt><dd className="tnum font-medium text-ink-50">{twd2(buyCost)} mTWD</dd></div>
                  <div className="flex justify-between">
                    <dt className="text-ink-300">餘額</dt>
                    <dd className={`tnum ${notEnough ? "text-down" : "text-ink-200"}`}>{twd2(balance)} mTWD</dd>
                  </div>
                </dl>
                {notEnough && <Notice kind="error">餘額不足，請先領取測試用 mTWD 或減少數量。</Notice>}
                <Button data-testid="submit-buy" onClick={() => setConfirm("buy")} disabled={!!busy || !buyReady} className="w-full">買進</Button>
              </div>
            )
          )}

          {/* 買進 · 市價 */}
          {side === "buy" && mode === "market" && (
            <div className="space-y-3">
              <p className="text-xs leading-6 text-ink-300">
                以目前市場價即時成交，不必挑專案。成交後<b className="text-ink-200">立刻拆解成具體批次</b>
                並存進您的持有清單，每一批都看得到專案、年份與核發國。目前市價池內為國內額度。
              </p>
              <Field label="數量（噸）">
                <input className={inputCls} type="number" step="0.001" min="0.001" value={marketTonnes}
                  onChange={(e) => setMarketTonnes(e.target.value)} data-testid="market-qty" />
              </Field>
              <div className="flex gap-1">
                {[1, 5, 10].map((t) => (
                  <button key={t} onClick={() => setMarketTonnes(String(t))}
                    className="flex-1 rounded border border-ink-500 py-1 text-xs text-ink-300 transition hover:border-tide/60 hover:text-ink-50">{t} 噸</button>
                ))}
              </div>
              <dl className="space-y-1 border-t border-ink-500 pt-3 text-sm">
                <div className="flex justify-between"><dt className="text-ink-300">目前市價</dt><dd className="tnum text-ink-50">{spot ? twd2(spot) : "—"} mTWD / 噸</dd></div>
                {quote === null ? (
                  <div className="flex justify-between"><dt className="text-ink-300">試算中…</dt><dd className="tnum text-ink-300">—</dd></div>
                ) : quote === "none" ? null : (
                  <>
                    <div className="flex justify-between"><dt className="text-ink-300">實際成交價</dt><dd className="tnum text-ink-50">{twd2(quote.perTonne)} mTWD / 噸</dd></div>
                    <div className="flex justify-between"><dt className="text-ink-300">應付金額</dt><dd className="tnum font-medium text-ink-50" data-testid="mbuy-cost">{twd2(quote.twd)} mTWD</dd></div>
                    {impact !== null && (
                      <div className="flex justify-between">
                        <dt className="text-ink-300">價格影響</dt>
                        <dd className={`tnum ${impact > 0.05 ? "text-warn" : "text-ink-200"}`}>{(impact * 100).toFixed(1)}%</dd>
                      </div>
                    )}
                    <div className="flex justify-between"><dt className="text-ink-300">最高支付</dt><dd className="tnum text-ink-200">{twd2(quote.twd * (1 + SLIPPAGE))} mTWD</dd></div>
                  </>
                )}
              </dl>
              {/* 報不出價就是池子吃不下這個量。與其讓他送出去撞一個看不懂的 revert，
                  不如現在就說清楚，並指回掛單簿——那裡的量體大得多。 */}
              {quote === "none" && (
                <Notice kind="error">
                  流動性不足，這個數量吃不下。市價池是即時成交用的，量體有限；
                  大額請改用<b>限價</b>從掛單簿買，或把數量調小。
                </Notice>
              )}
              {impact !== null && impact > 0.05 && (
                <Notice kind="info">
                  這筆會把價格推高 {(impact * 100).toFixed(1)}%——市價池薄，量一大就滑價。
                  同樣的量從<b>限價</b>掛單簿買通常便宜得多。
                </Notice>
              )}
              {mBuyCost > balance && <Notice kind="error">餘額不足。</Notice>}
              <Button data-testid="submit-market-buy" onClick={() => setConfirm("mbuy")} disabled={!!busy || !mBuyReady} className="w-full">市價買進</Button>
            </div>
          )}

          {/* 賣出（限價與市價共用批次選擇） */}
          {side === "sell" && (
            tier === 0 ? (
              <p className="text-sm leading-7 text-ink-200">
                尚未完成身分驗證，不能買賣。請先到<Link className="text-tide underline" href="/kyc">身分驗證</Link>辦理。
              </p>
            ) : myBatches.length === 0 ? (
              <p className="text-sm text-ink-300">目前沒有可賣出的碳權。</p>
            ) : (
              <div className="space-y-3" data-testid="sell-row">
                <Field label="選擇批次">
                  <select className={inputCls} value={sb?.batchId ?? ""} onChange={(e) => setSellBatch(Number(e.target.value))}>
                    {myBatches.map((b) => (
                      <option key={b.batchId} value={b.batchId}>
                        {b.country} #{b.batchId}　{b.project}　{b.vintageYear}　持有 {fmtKg(b.kg)}
                      </option>
                    ))}
                  </select>
                </Field>
                {sb && <CountryTag code={sb.country} scheme={sb.scheme} />}
                <Field label={`數量（噸，最多 ${sb ? (sb.kg / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 3 }) : 0}）`}>
                  <input className={inputCls} type="number" step="0.001" value={sf?.tonnes ?? ""} onChange={(e) => setSf({ tonnes: e.target.value })} />
                </Field>

                {mode === "limit" ? (
                  <>
                    <Field label="單價 mTWD / 噸">
                      <input className={inputCls} type="number" value={sf?.price ?? ""} onChange={(e) => setSf({ price: e.target.value })} />
                    </Field>
                    {spot && <p className="text-xs text-ink-300">市場參考價 {twd2(spot)} mTWD / 噸</p>}
                    <button onClick={() => setAdvanced((v) => !v)} className="text-xs text-ink-300 underline">
                      {advanced ? "收起進階設定" : "進階設定（最小成交量、使用期限）"}
                    </button>
                    {advanced && (
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="最小成交（噸）">
                          <input className={inputCls} type="number" step="0.001" value={sf?.minFill ?? ""} onChange={(e) => setSf({ minFill: e.target.value })} />
                        </Field>
                        <Field label="使用期限">
                          <input className={inputCls} type="date" value={sf?.usageDeadline ?? ""} onChange={(e) => setSf({ usageDeadline: e.target.value })} />
                        </Field>
                      </div>
                    )}
                    <dl className="space-y-1 border-t border-ink-500 pt-3 text-sm">
                      <div className="flex justify-between"><dt className="text-ink-300">預計成交金額</dt><dd className="tnum text-ink-50">{twd2(sellProceeds)} mTWD</dd></div>
                      <div className="flex justify-between"><dt className="text-ink-300">平台手續費 {(m?.listingFeeBps ?? 0) / 100}%</dt><dd className="tnum text-down">− {twd2(sellFee)}</dd></div>
                      <div className="flex justify-between"><dt className="text-ink-300">實收</dt><dd className="tnum font-medium text-ink-50">{twd2(sellProceeds - sellFee)} mTWD</dd></div>
                    </dl>
                    <Button data-testid="submit-sell" onClick={() => setConfirm("sell")} disabled={!!busy || !sellReady} className="w-full">賣出（上架）</Button>
                  </>
                ) : (
                  <>
                    <p className="text-xs leading-6 text-ink-300">
                      以目前市場價即時賣出，不必等買方。價格由當下市場決定，
                      低於參考價 {SLIPPAGE * 100}% 就會讓交易失敗，不會默默成交在爛價格上。
                    </p>
                    {sb && sb.country !== "TW" && (
                      <Notice kind="info">
                        即時市價目前只承接國內額度。這批是{flagOf(sb.country)} {sb.country} 的額度，請改用限價掛單賣出。
                      </Notice>
                    )}
                    <dl className="space-y-1 border-t border-ink-500 pt-3 text-sm">
                      <div className="flex justify-between"><dt className="text-ink-300">目前市價</dt><dd className="tnum text-ink-50">{spot ? twd2(spot) : "—"} mTWD / 噸</dd></div>
                      <div className="flex justify-between"><dt className="text-ink-300">預估實收</dt><dd className="tnum font-medium text-ink-50">{twd2(mSellProceeds)} mTWD</dd></div>
                      <div className="flex justify-between"><dt className="text-ink-300">最低實收</dt><dd className="tnum text-ink-200">{twd2(mSellProceeds * (1 - SLIPPAGE))} mTWD</dd></div>
                    </dl>
                    <Button data-testid="submit-market-sell" onClick={() => setConfirm("msell")} disabled={!!busy || !mSellReady} className="w-full">市價賣出</Button>
                  </>
                )}
              </div>
            )
          )}
        </Card>
      </div>

      {myOrders.length > 0 && (
        <Card title={`我的掛單（${myOrders.length}）`}>
          <ul className="space-y-2 text-sm">
            {myOrders.map((o) => (
              <li key={o.orderId} className="flex flex-wrap items-center gap-3 rounded-[--radius-card] border border-ink-500 p-3">
                <CountryTag code={o.country} scheme={o.scheme} />
                <span className="flex-1">掛單 #{o.orderId} · 批次 #{o.batchId} · 剩餘 {fmtKg(o.remainingKg)} · {fmtTwd(o.pricePerTonne)} mTWD / 噸</span>
                <Button variant="secondary" onClick={() => cancelOrder(o)} disabled={!!busy}>取消掛單</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="text-xs leading-6 text-ink-300">
        買賣移轉的是本站的請求權，不動各國官方登錄簿，轉幾手都不消耗那唯一一次官方移轉。
        額度本身託管在各國政府的登錄簿帳戶內，對帳狀況見<Link className="text-tide underline" href="/custody">託管揭露</Link>。
        要把額度用掉請到<Link className="text-tide underline" href="/retire">註銷</Link>（限具額度帳戶之事業）。
      </p>

      {/* ── 確認單 ───────────────────────────── */}
      {confirm === "buy" && selected && (
        <ConfirmDialog
          title="確認買進"
          onCancel={() => setConfirm(null)}
          onSubmit={async () => { await buyGate.accept(`order:${selected.orderId}`); doBuy(); }}
          submitLabel={busy ? "簽章中…" : "以 passkey 簽章買進"}
          disabled={!!busy || !buyGate.ok || (tier === 1 && !naturalAck)}
          rows={[
            ["專案", selected.project.name],
            ["核發國 / 機制", `${flagOf(selected.country)} ${selected.country}　${selected.scheme}`],
            ["批次 / 年份", `#${selected.batchId}　${selected.vintageYear}`],
            ["數量", fmtKg(Number(qtyKg))],
            ["單價", `${fmtTwd(selected.pricePerTonne)} mTWD / 噸`],
            ["應付金額", `${twd2(buyCost)} mTWD`],
            ["手續費", "0（買方不負擔，手續費由賣方承擔）"],
          ]}
        >
          <ForeignNotice country={selected.country} />
          <p className="text-xs leading-6 text-ink-300">
            按下確認後會立刻以 passkey 簽章並上鏈，<b className="text-ink-200">價金與額度同時交割，無法取消</b>。
          </p>
          <AgreementCheck gate={buyGate} />
          {tier === 1 && <NaturalAck checked={naturalAck} onChange={setNaturalAck} />}
        </ConfirmDialog>
      )}

      {confirm === "mbuy" && (
        <ConfirmDialog
          title="確認市價買進"
          onCancel={() => setConfirm(null)}
          onSubmit={async () => { await buyGate.accept("market"); doMarketBuy(); }}
          submitLabel={busy ? "簽章中…" : "以 passkey 簽章買進"}
          disabled={!!busy || !buyGate.ok || (tier === 1 && !naturalAck)}
          rows={[
            ["方式", "市價即時成交"],
            ["數量", `${marketTonnes} 噸`],
            ["目前市價", `${spot ? twd2(spot) : "—"} mTWD / 噸`],
            ["預估金額", `${twd2(mBuyCost)} mTWD`],
            ["最高支付", `${twd2(mBuyCost * (1 + SLIPPAGE))} mTWD`],
            ["交割方式", "成交後立刻拆解為具體批次"],
          ]}
        >
          <p className="text-xs leading-6 text-ink-300">
            市價單沒有指定專案：系統會依序交割目前可交割的批次，成交後您會在資產頁看到完整清單。
            成交價由當下市場決定，超過最高支付金額交易就會失敗。
          </p>
          <AgreementCheck gate={buyGate} />
          {tier === 1 && <NaturalAck checked={naturalAck} onChange={setNaturalAck} />}
        </ConfirmDialog>
      )}

      {confirm === "sell" && sb && sf && (
        <ConfirmDialog
          title="確認上架賣出"
          onCancel={() => setConfirm(null)}
          onSubmit={async () => { await sellGate.accept(`batch:${sb.batchId}`); doSell(); }}
          submitLabel={busy ? "簽章中…" : "以 passkey 簽章上架"}
          disabled={!!busy || !sellGate.ok}
          rows={[
            ["批次 / 專案", `#${sb.batchId}　${sb.project}`],
            ["核發國 / 機制", `${flagOf(sb.country)} ${sb.country}　${sb.scheme}`],
            ["數量", `${Number(sf.tonnes).toLocaleString("zh-TW", { maximumFractionDigits: 3 })} 噸`],
            ["單價", `${twd2(Number(sf.price))} mTWD / 噸`],
            [`平台手續費 ${(m?.listingFeeBps ?? 0) / 100}%`, `− ${twd2(sellFee)} mTWD`],
            ["實收", `${twd2(sellProceeds - sellFee)} mTWD`],
            ["使用期限（依第 12 條申報）", sf.usageDeadline || "未填"],
          ]}
        >
          <p className="text-xs leading-6 text-ink-300">
            上架後額度會轉入掛單合約保管，買方可隨時成交；未成交前可取消取回。
            上架即公告，並代表您承諾<b className="text-ink-200">在最終買方申請註銷時配合辦理官方移轉</b>——
            不配合將失去上架資格、不適用每噸代辦費減免，已減免者將被追繳。
          </p>
          <AgreementCheck gate={sellGate} />
        </ConfirmDialog>
      )}

      {confirm === "msell" && sb && sf && (
        <ConfirmDialog
          title="確認市價賣出"
          onCancel={() => setConfirm(null)}
          onSubmit={async () => { await sellGate.accept(`market:${sb.batchId}`); doMarketSell(); }}
          submitLabel={busy ? "簽章中…" : "以 passkey 簽章賣出"}
          disabled={!!busy || !sellGate.ok}
          rows={[
            ["方式", "市價即時成交"],
            ["批次 / 專案", `#${sb.batchId}　${sb.project}`],
            ["數量", `${Number(sf.tonnes).toLocaleString("zh-TW", { maximumFractionDigits: 3 })} 噸`],
            ["目前市價", `${spot ? twd2(spot) : "—"} mTWD / 噸`],
            ["預估實收", `${twd2(mSellProceeds)} mTWD`],
            ["最低實收", `${twd2(mSellProceeds * (1 - SLIPPAGE))} mTWD`],
          ]}
        >
          <p className="text-xs leading-6 text-ink-300">
            即時成交，賣出後這批額度就不在您名下了。實收金額低於最低實收時交易會失敗。
          </p>
          <AgreementCheck gate={sellGate} />
        </ConfirmDialog>
      )}
    </div>
  );
}

/// 國外額度的用途限制。寫在下單前，不是寫在事後的說明頁。
function ForeignNotice({ country }: { country: string }) {
  if (country === "TW") return null;
  return (
    <div className="rounded-[--radius-ctl] border border-warn/40 bg-warn/5 p-3 text-xs leading-6 text-ink-200">
      <b>這是國外減量額度（{flagOf(country)} {country}）。</b>
      依氣候變遷因應法第 27 條，國外額度須經中央主管機關認可後，才能用於扣除碳費排放量或抵銷超額量；
      依碳費收費辦法第 10 條，扣除上限為<b>收費排放量的 5%</b>，且<b>高碳洩漏風險事業不得使用</b>。
      國外額度<b>不能用於環評增量抵換</b>——本站在註銷時會擋下這個選項。
      認可申請由貴單位自行向主管機關辦理，本站不代為申請，也不保證取得認可。
    </div>
  );
}

function NaturalAck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 rounded-[--radius-ctl] border border-warn/40 bg-warn/5 p-3 text-sm">
      <input type="checkbox" className="mt-1 accent-[--color-tide]" checked={checked}
        onChange={(e) => onChange(e.target.checked)} data-testid="natural-ack" />
      <span className="text-ink-200">
        我明瞭<b>自然人無法在官方登錄簿註銷額度</b>，我買到的可以持有、也可以再賣出，
        但不能用於碳費扣抵、環評抵換等法定申報，也不能據以對外宣稱碳中和。
      </span>
    </label>
  );
}

/// 確認單。刻意做成擋在畫面前的對話框而不是頁面裡的一段——
/// 「下單前明確提示」要有打斷的效果，順順滑過去就沒有意義了。
function ConfirmDialog({
  title, rows, children, onCancel, onSubmit, submitLabel, disabled,
}: {
  title: string;
  rows: [string, string][];
  children?: React.ReactNode;
  onCancel: () => void;
  onSubmit: () => void | Promise<void>;
  submitLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/70 p-4 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-[--radius-card] border border-ink-500 bg-ink-700 p-5 shadow-xl">
        <h2 className="font-display text-lg font-semibold text-ink-50">{title}</h2>
        <dl className="mt-4 divide-y divide-ink-500 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 py-2">
              <dt className="text-ink-300">{k}</dt>
              <dd className="tnum text-right font-medium text-ink-50">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 space-y-3">{children}</div>
        <div className="mt-5 flex gap-2">
          <Button variant="secondary" onClick={onCancel} className="flex-1">返回修改</Button>
          <Button onClick={() => void onSubmit()} disabled={disabled} className="flex-1">{submitLabel}</Button>
        </div>
      </div>
    </div>
  );
}
