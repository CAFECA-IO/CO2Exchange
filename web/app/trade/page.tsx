"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useReload } from "@/lib/client/useReload";
import { encodeFunctionData, type Address } from "viem";
import { useAccount } from "@/components/AccountProvider";
import { AccountGate } from "@/components/AccountGate";
import { AgreementCheck, useAgreementGate } from "@/components/AgreementGate";
import { Button, Card, Field, Notice, fmtKg, fmtTwd, inputCls } from "@/components/ui";
import { erc1155ApprovalAbi, erc20Abi, listingAbi, listingWriteAbi, routerAbi } from "@/lib/abis";
import { signAndRelay, type Call } from "@/lib/client/passkey";

/// 交易頁：買進與賣出在同一頁，切分頁切換。
///
/// 設計目標是使用者只需要處理兩件事——**數量**與**單價**。其他該填的（最小成交量、
/// 使用期限）都給合理預設，收在「進階」裡；真正重要的是送出前那張確認單：
/// 把成交條件、費用、對方、契約一次攤開，按下去就是簽章上鏈，沒有反悔。
///
/// 註銷不在這裡。註銷是「用掉」，跟買賣是兩件事，而且自然人根本不能做；
/// 混在同一頁只會讓人以為買完就要註銷。搬到 /retire。

type Order = {
  orderId: number; seller: string; batchId: number; remainingKg: number; pricePerTonne: string;
  minFillKg: number; project: { name: string; methodology: string; location: string }; vintageYear: number;
};
type Market = {
  orders: Order[]; spotPricePerTonne: number | null; listingFeeBps: number;
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address } | null;
  holdings: { twd: string; cct: string; batches: { batchId: number; kg: number; vintageYear: number; project: string }[] } | null;
};

const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;

/// 使用期限預設一年後：交易拍賣及移轉管理辦法第 12 條要求申報，但多數賣方不會想這件事，
/// 給一個合理值讓他只管數量與單價，要改再改。
function oneYearLater() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}
const defaultSell = (kg: number) => ({ tonnes: String(kg / 1000), price: "800", minFill: "0.1", usageDeadline: oneYearLater() });
const twd2 = (v: number) => v.toLocaleString("zh-TW", { maximumFractionDigits: 2 });

export default function TradePage() {
  const { credential, config, userId, tier } = useAccount();
  const [m, setM] = useState<Market | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [selected, setSelected] = useState<Order | null>(null);
  const [qtyKg, setQtyKg] = useState("1000");
  const [twdIn, setTwdIn] = useState("2000");
  const [advanced, setAdvanced] = useState(false);
  const [sellBatch, setSellBatch] = useState<number | null>(null);
  const [sellForm, setSellForm] = useState<Record<number, { tonnes: string; price: string; minFill: string; usageDeadline: string }>>({});
  const [naturalAck, setNaturalAck] = useState(false);
  /// 送出前的確認單。null = 沒有待確認的單。
  const [confirm, setConfirm] = useState<null | "buy" | "sell">(null);

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

  /// sb 是「目前選定的批次」，沒有明確選過時就是第一個——下單面板顯示的也是它，
  /// 所以這裡必須跟著 sb 走，不能只看 sellBatch，否則沒動過下拉選單就會靜靜地送不出去。
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

  function cancelOrder(o: Order) {
    relay(`取消掛單 #${o.orderId}`, [
      { target: d.listing, value: 0n, data: encodeFunctionData({ abi: listingWriteAbi, functionName: "cancel", args: [BigInt(o.orderId)] }) },
    ]);
  }

  function buyPool() {
    const amountIn = BigInt(Math.round(Number(twdIn) * 1e6));
    if (!m?.poolKey) return;
    const zeroForOne = m.poolKey.currency0.toLowerCase() === d.settlementToken.toLowerCase();
    relay(`流動性池購買（${twdIn} mTWD）`, [
      { target: d.settlementToken, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.router, amountIn] }) },
      { target: d.router, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "swap", args: [
        m.poolKey, { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT + 1n : MAX_SQRT - 1n },
        0n, BigInt(Math.floor(Date.now() / 1000) + 600) ] }) },
    ]);
  }

  const h = m?.holdings;
  const myBatches = h?.batches ?? [];
  const myOrders = (m?.orders ?? []).filter((o) => o.seller?.toLowerCase() === credential.address.toLowerCase());
  const cctKg = h ? Math.floor(Number(BigInt(h.cct) / 10n ** 15n)) : 0;
  const maxDepthKg = Math.max(1, ...(m?.orders ?? []).map((o) => o.remainingKg));
  const buyCost = selected ? (Number(qtyKg || 0) * Number(selected.pricePerTonne)) / 1000 / 1e6 : 0;
  const balance = h ? Number(h.twd) / 1e6 : 0;
  const notEnough = buyCost > balance;

  const sb = myBatches.find((x) => x.batchId === sellBatch) ?? myBatches[0];
  const sf = sb ? (sellForm[sb.batchId] ?? defaultSell(sb.kg)) : null;
  const setSf = (patch: Partial<NonNullable<typeof sf>>) => sb && sf && setSellForm({ ...sellForm, [sb.batchId]: { ...sf, ...patch } });
  const sellProceeds = sf ? Number(sf.tonnes) * Number(sf.price) : 0;
  const sellFee = (sellProceeds * (m?.listingFeeBps ?? 0)) / 10_000;

  const buyReady = !!selected && !!qtyKg && Number(qtyKg) >= (selected.minFillKg || 1) && !notEnough;
  const sellReady = !!sb && !!sf && Number(sf.tonnes) > 0 && Number(sf.price) > 0 && Number(sf.tonnes) * 1000 <= sb.kg;

  return (
    <div className="space-y-5">
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      {/* 餘額列：一行帶過，別佔掉交易的版面 */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[--radius-card] border border-ink-500 bg-ink-700 px-4 py-3 text-sm">
        <span className="text-ink-300">可用現金</span>
        <b className="tnum text-ink-50" data-testid="twd">{h ? fmtTwd(h.twd) : "—"} mTWD</b>
        <span className="text-ink-300">池化額度</span>
        <b className="tnum text-ink-50" data-testid="cct">{fmtKg(cctKg)}</b>
        <span className="text-ink-300">批次額度</span>
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
        <Card title="掛單簿" action={<span className="text-xs text-ink-300">賣單，由最佳價排起</span>}>
          {!m ? <p className="text-sm text-ink-300">讀取中…</p> : m.orders.length === 0 ? (
            <p className="text-sm text-ink-300">目前沒有掛單。</p>
          ) : (
            <div>
              <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 border-b border-ink-500 pb-1.5 text-[11px] uppercase tracking-wider text-ink-300">
                <span>專案 / 批次</span><span className="text-right">數量</span><span className="text-right">價格 / 噸</span>
              </div>
              <ul className="max-h-[420px] divide-y divide-ink-500 overflow-auto">
                {m.orders.map((o) => {
                  const depth = Math.min(100, (o.remainingKg / maxDepthKg) * 100);
                  const sel = selected?.orderId === o.orderId;
                  const mine = o.seller?.toLowerCase() === credential.address.toLowerCase();
                  return (
                    <li key={o.orderId}>
                      <button
                        onClick={() => { setSide("buy"); setSelected(o); setQtyKg(String(Math.min(1000, o.remainingKg))); }}
                        className={`relative grid w-full grid-cols-[1fr_auto_auto] gap-x-4 px-1 py-2 text-left text-sm transition hover:bg-ink-600 ${sel ? "bg-ink-600" : ""}`}
                        aria-pressed={sel}
                      >
                        <span className="pointer-events-none absolute inset-y-0 right-0 bg-down/12" style={{ width: `${depth}%` }} aria-hidden />
                        <span className="relative min-w-0">
                          <span className="block truncate text-ink-50">
                            {o.project.name}
                            {mine && <span className="ml-2 rounded bg-ink-600 px-1.5 py-0.5 text-[10px] text-ink-300">我的掛單</span>}
                          </span>
                          <span className="block truncate text-xs text-ink-300">{o.project.methodology} · {o.vintageYear} · 批次 #{o.batchId}</span>
                        </span>
                        <span className="tnum relative self-center text-right text-ink-200">{fmtKg(o.remainingKg)}</span>
                        <span className="tnum relative self-center text-right font-medium text-down">{fmtTwd(o.pricePerTonne)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-xs text-ink-300">顯示最新 {m.orders.length} 筆有效掛單。平台手續費 {(m.listingFeeBps ?? 0) / 100}%，由賣方承擔。</p>
            </div>
          )}
        </Card>

        {/* ── 下單面板：買 / 賣 ─────────────────── */}
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
          {side === "buy" ? (
            !selected ? (
              <p className="text-sm text-ink-300">從左邊的掛單簿點一筆來下單。</p>
            ) : (
              <div className="space-y-3">
                <div className="rounded-[--radius-ctl] border border-ink-500 bg-ink-800 p-3 text-sm">
                  <div className="text-ink-50">{selected.project.name}</div>
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
          ) : tier === 0 ? (
            <p className="text-sm leading-7 text-ink-200">
              尚未完成身分驗證，不能買賣。請先到<Link className="text-tide underline" href="/kyc">身分驗證</Link>辦理。
            </p>
          ) : myBatches.length === 0 ? (
            <p className="text-sm text-ink-300">目前沒有可上架的批次額度。（池化額度 CCT 需先贖回成批次才能掛單。）</p>
          ) : (
            <div className="space-y-3" data-testid="sell-row">
              <Field label="選擇批次">
                <select
                  className={inputCls}
                  value={sb?.batchId ?? ""}
                  onChange={(e) => setSellBatch(Number(e.target.value))}
                >
                  {myBatches.map((b) => (
                    <option key={b.batchId} value={b.batchId}>#{b.batchId}　{b.project}　{b.vintageYear}　持有 {fmtKg(b.kg)}</option>
                  ))}
                </select>
              </Field>
              <Field label={`數量（噸，最多 ${sb ? (sb.kg / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 3 }) : 0}）`}>
                <input className={inputCls} type="number" step="0.001" value={sf?.tonnes ?? ""} onChange={(e) => setSf({ tonnes: e.target.value })} />
              </Field>
              <Field label="單價 mTWD / 噸">
                <input className={inputCls} type="number" value={sf?.price ?? ""} onChange={(e) => setSf({ price: e.target.value })} />
              </Field>
              {m?.spotPricePerTonne && (
                <p className="text-xs text-ink-300">市場參考價 {m.spotPricePerTonne.toLocaleString("zh-TW", { maximumFractionDigits: 0 })} mTWD / 噸</p>
              )}

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
            </div>
          )}
        </Card>
      </div>

      {myOrders.length > 0 && (
        <Card title={`我的掛單（${myOrders.length}）`}>
          <ul className="space-y-2 text-sm">
            {myOrders.map((o) => (
              <li key={o.orderId} className="flex flex-wrap items-center gap-3 rounded-[--radius-card] border border-ink-500 p-3">
                <span className="flex-1">掛單 #{o.orderId} · 批次 #{o.batchId} · 剩餘 {fmtKg(o.remainingKg)} · {fmtTwd(o.pricePerTonne)} mTWD / 噸</span>
                <Button variant="secondary" onClick={() => cancelOrder(o)} disabled={!!busy}>取消掛單</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(!m || m.poolKey) && (
        <details className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
          <summary className="cursor-pointer text-sm font-medium text-ink-200">進階：流動性池（Uniswap v4，展示用）</summary>
          <p className="mt-3 text-sm text-ink-300">
            現貨參考價 {m?.spotPricePerTonne ? `${m.spotPricePerTonne.toLocaleString("zh-TW", { maximumFractionDigits: 0 })} mTWD / 噸` : "—"}（不含 0.3% 手續費與滑價）
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Field label="支付 mTWD"><input className={inputCls} type="number" min="1" value={twdIn} onChange={(e) => setTwdIn(e.target.value)} /></Field>
            <Button onClick={buyPool} disabled={!!busy || !m}>{busy?.startsWith("流動性池") ? "簽章中…" : "以 passkey 簽章購買"}</Button>
          </div>
        </details>
      )}

      <p className="text-xs leading-6 text-ink-300">
        買賣移轉的是本站的請求權，不動官方登錄簿，轉幾手都不消耗那唯一一次官方移轉。
        要把額度用掉請到<Link className="text-tide underline" href="/retire">註銷</Link>（限具額度帳戶之事業）。
      </p>

      {/* ── 送出前的確認單 ───────────────────── */}
      {confirm === "buy" && selected && (
        <ConfirmDialog
          title="確認買進"
          onCancel={() => setConfirm(null)}
          onSubmit={async () => { await buyGate.accept(`order:${selected.orderId}`); doBuy(); }}
          submitLabel={busy ? "簽章中…" : "以 passkey 簽章買進"}
          disabled={!!busy || !buyGate.ok || (tier === 1 && !naturalAck)}
          rows={[
            ["專案", selected.project.name],
            ["批次 / 年份", `#${selected.batchId}　${selected.vintageYear}`],
            ["數量", fmtKg(Number(qtyKg))],
            ["單價", `${fmtTwd(selected.pricePerTonne)} mTWD / 噸`],
            ["應付金額", `${twd2(buyCost)} mTWD`],
            ["手續費", "0（買方不負擔，手續費由賣方承擔）"],
            ["賣方", `${selected.seller.slice(0, 6)}…${selected.seller.slice(-4)}`],
          ]}
        >
          <p className="text-xs leading-6 text-ink-300">
            按下確認後會立刻以 passkey 簽章並上鏈，<b className="text-ink-200">價金與額度同時交割，無法取消</b>。
            這筆交易會即時出現在公告欄。
          </p>
          <AgreementCheck gate={buyGate} />
          {tier === 1 && (
            <label className="flex items-start gap-2 rounded-[--radius-ctl] border border-warn/40 bg-warn/5 p-3 text-sm">
              <input type="checkbox" className="mt-1 accent-[--color-tide]" checked={naturalAck}
                onChange={(e) => setNaturalAck(e.target.checked)} data-testid="natural-ack" />
              <span className="text-ink-200">
                我明瞭<b>自然人無法在官方登錄簿註銷額度</b>，我買到的可以持有、也可以再賣出，
                但不能用於碳費扣抵、環評抵換等法定申報，也不能據以對外宣稱碳中和。
              </span>
            </label>
          )}
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
            ["數量", `${Number(sf.tonnes).toLocaleString("zh-TW", { maximumFractionDigits: 3 })} 噸`],
            ["單價", `${twd2(Number(sf.price))} mTWD / 噸`],
            ["預計成交金額", `${twd2(sellProceeds)} mTWD`],
            [`平台手續費 ${(m?.listingFeeBps ?? 0) / 100}%`, `− ${twd2(sellFee)} mTWD`],
            ["實收", `${twd2(sellProceeds - sellFee)} mTWD`],
            ["最小成交量", `${sf.minFill} 噸`],
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
    </div>
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
