"use client";
import { useEffect, useState } from "react";
import { useReload } from "@/lib/client/useReload";
import { encodeFunctionData, keccak256, toBytes, type Address, type Hex } from "viem";
import { useAccount } from "@/components/AccountProvider";
import { AccountGate } from "@/components/AccountGate";
import { Button, Card, Field, Notice, fmtKg, fmtTwd, inputCls } from "@/components/ui";
import { creditAbi, erc20Abi, listingAbi, poolAbi, routerAbi } from "@/lib/abis";
import { PURPOSE_LABEL } from "@/lib/deployment";
import { signAndRelay, type Call } from "@/lib/client/passkey";

type Order = { orderId: number; batchId: number; remainingKg: number; pricePerTonne: string; minFillKg: number; project: { name: string; methodology: string; location: string }; vintageYear: number };
type Market = {
  orders: Order[]; spotPricePerTonne: number | null; listingFeeBps: number;
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address } | null; // SKIP_V4 部署時為 null
  holdings: { twd: string; cct: string; batches: { batchId: number; kg: number; vintageYear: number; project: string }[] } | null;
};

const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;

export default function TradePage() {
  const { credential, config, userId } = useAccount();
  const [m, setM] = useState<Market | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Order | null>(null);
  const [qtyKg, setQtyKg] = useState("1000");
  const [twdIn, setTwdIn] = useState("2000");
  const [beneficiary, setBeneficiary] = useState("");
  const [purpose, setPurpose] = useState(1);
  const [memo, setMemo] = useState("");
  const [retireKg, setRetireKg] = useState<Record<string, string>>({});

  const [reloadKey, reload] = useReload();
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

  async function relay(label: string, calls: Call[]) {
    setBusy(label); setMsg(null);
    try {
      const r = await signAndRelay(config!.rpcUrl, credential!, calls);
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

  function buyListing(o: Order, amountKg: number) {
    const kg = BigInt(Math.min(o.remainingKg, Math.max(1, Math.round(amountKg))));
    const cost = (kg * BigInt(o.pricePerTonne)) / 1000n;
    relay(`購買 ${fmtKg(Number(kg))}`, [
      { target: d.settlementToken, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.listing, cost] }) },
      { target: d.listing, value: 0n, data: encodeFunctionData({ abi: listingAbi, functionName: "buy", args: [BigInt(o.orderId), kg] }) },
    ]);
  }

  function buyPool() {
    const amountIn = BigInt(Math.round(Number(twdIn) * 1e6));
    if (!m?.poolKey) return; // 這條鏈沒部署 v4 模組
    const zeroForOne = m.poolKey.currency0.toLowerCase() === d.settlementToken.toLowerCase();
    relay(`流動性池購買（${twdIn} mTWD）`, [
      { target: d.settlementToken, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.router, amountIn] }) },
      { target: d.router, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "swap", args: [
        m.poolKey, { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT + 1n : MAX_SQRT - 1n },
        0n, BigInt(Math.floor(Date.now() / 1000) + 600) ] }) },
    ]);
  }

  const beneficiaryHash = (): Hex => keccak256(toBytes(beneficiary || credential!.address));

  function retireBatch(batchId: number, maxKg: number) {
    const kg = BigInt(Math.min(maxKg, Math.max(1, Math.round(Number(retireKg[`b${batchId}`] ?? maxKg)))));
    relay(`註銷批次 #${batchId} ${fmtKg(Number(kg))}`, [{
      target: d.carbonCredit1155, value: 0n,
      data: encodeFunctionData({ abi: creditAbi, functionName: "retire", args: [{
        holder: credential!.address, batchId: BigInt(batchId), amountKg: kg, certificateTo: credential!.address,
        beneficiaryHash: beneficiaryHash(), beneficiary, purpose, memo }] }),
    }]);
  }

  function retireCct(maxKg: number) {
    const kg = BigInt(Math.min(maxKg, Math.max(1, Math.round(Number(retireKg.cct ?? maxKg)))));
    relay(`註銷池化額度 ${fmtKg(Number(kg))}`, [{
      target: d.carbonPool, value: 0n,
      data: encodeFunctionData({ abi: poolAbi, functionName: "redeemAndRetire", args: [kg, beneficiaryHash(), beneficiary, purpose, memo] }),
    }]);
  }

  const h = m?.holdings;
  const cctKg = h ? Math.floor(Number(BigInt(h.cct) / 10n ** 15n)) : 0;
  // 深度條的基準：本頁最大的那筆掛單量
  const maxDepthKg = Math.max(1, ...(m?.orders ?? []).map((o) => o.remainingKg));
  const cost = selected ? (Number(qtyKg || 0) * Number(selected.pricePerTonne)) / 1000 / 1e6 : 0;

  return (
    <div className="space-y-6">
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div className="grid gap-6 md:grid-cols-3">
        <Card title="我的餘額">
          {h ? (
            <dl className="space-y-1 text-sm">
              <div><dt className="text-ink-300">結算幣 mTWD</dt><dd data-testid="twd">{fmtTwd(h.twd)}</dd></div>
              <div><dt className="text-ink-300">池化額度 CCT</dt><dd data-testid="cct">{fmtKg(cctKg)}</dd></div>
              <div><dt className="text-ink-300">批次額度</dt><dd data-testid="batches">{h.batches.length ? h.batches.map((b) => `#${b.batchId} ${fmtKg(b.kg)}`).join("、") : "—"}</dd></div>
            </dl>
          ) : <p className="text-sm text-ink-300">讀取中…</p>}
          <div className="mt-3"><Button variant="secondary" onClick={faucet} disabled={!!busy}>領取測試用 mTWD</Button></div>
        </Card>

        {(!m || m.poolKey) && (
          <Card title="流動性池（Uniswap v4，展示）" className="md:col-span-2">
            <p className="mb-2 text-sm text-ink-300">
              現貨參考價 {m?.spotPricePerTonne ? `${m.spotPricePerTonne.toLocaleString("zh-TW", { maximumFractionDigits: 0 })} mTWD / 噸` : "—"}（不含 0.3% 手續費與滑價）
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="支付 mTWD"><input className={inputCls} type="number" min="1" value={twdIn} onChange={(e) => setTwdIn(e.target.value)} /></Field>
              <Button onClick={buyPool} disabled={!!busy || !m}>{busy?.startsWith("流動性池") ? "簽章中…" : "以 passkey 簽章購買"}</Button>
            </div>
          </Card>
        )}
      </div>

      {/* 掛單簿 + 下單面板：交易所的標準版面 */}
      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <Card title="掛單簿" action={<span className="text-xs text-ink-300">賣單，由最佳價排起</span>}>
          {!m ? (
            <p className="text-sm text-ink-300">讀取中…</p>
          ) : m.orders.length === 0 ? (
            <p className="text-sm text-ink-300">目前沒有掛單。</p>
          ) : (
            <div className="overflow-hidden">
              <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 border-b border-ink-500 pb-1.5 text-[11px] uppercase tracking-wider text-ink-300">
                <span>專案 / 批次</span>
                <span className="text-right">數量</span>
                <span className="text-right">價格 / 噸</span>
              </div>
              <ul className="max-h-[420px] divide-y divide-ink-500 overflow-auto">
                {m.orders.map((o) => {
                  const depth = Math.min(100, (o.remainingKg / maxDepthKg) * 100);
                  const sel = selected?.orderId === o.orderId;
                  return (
                    <li key={o.orderId}>
                      <button
                        onClick={() => { setSelected(o); setQtyKg(String(Math.min(1000, o.remainingKg))); }}
                        className={`relative grid w-full grid-cols-[1fr_auto_auto] gap-x-4 px-1 py-2 text-left text-sm transition hover:bg-ink-600 ${sel ? "bg-ink-600" : ""}`}
                        aria-pressed={sel}
                      >
                        {/* 深度條：賣壓用下跌色，濃度代表這個價位的量 */}
                        <span
                          className="pointer-events-none absolute inset-y-0 right-0 bg-down/12"
                          style={{ width: `${depth}%` }}
                          aria-hidden
                        />
                        <span className="relative min-w-0">
                          <span className="block truncate text-ink-50">{o.project.name}</span>
                          <span className="block truncate text-xs text-ink-300">
                            {o.project.methodology} · {o.vintageYear} · 批次 #{o.batchId}
                          </span>
                        </span>
                        <span className="tnum relative self-center text-right text-ink-200">{fmtKg(o.remainingKg)}</span>
                        <span className="tnum relative self-center text-right font-medium text-down">{fmtTwd(o.pricePerTonne)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {m && <p className="mt-2 text-xs text-ink-300">顯示最新 {m.orders.length} 筆有效掛單。平台手續費 {m.listingFeeBps / 100}%，由賣方承擔。</p>}
        </Card>

        <Card title="買進">
          {!selected ? (
            <p className="text-sm text-ink-300">從左邊的掛單簿點一筆來下單。</p>
          ) : (
            <div className="space-y-3">
              <div className="rounded-[--radius-ctl] border border-ink-500 bg-ink-800 p-3 text-sm">
                <div className="text-ink-50">{selected.project.name}</div>
                <div className="mt-0.5 text-xs text-ink-300">
                  {selected.project.methodology} · {selected.project.location} · {selected.vintageYear} 年份 · 批次 #{selected.batchId}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-ink-300">價格 / 噸</div>
                  <div className="tnum font-medium text-down">{fmtTwd(selected.pricePerTonne)}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-ink-300">可買數量</div>
                  <div className="tnum font-medium text-ink-50">{fmtKg(selected.remainingKg)}</div>
                </div>
              </div>

              <Field label={`數量（kg，最少 ${selected.minFillKg || 1}）`}>
                <input
                  className={inputCls}
                  type="number"
                  min={selected.minFillKg || 1}
                  max={selected.remainingKg}
                  value={qtyKg}
                  onChange={(e) => setQtyKg(e.target.value)}
                />
              </Field>
              <div className="flex gap-1">
                {[25, 50, 75, 100].map((pct) => (
                  <button
                    key={pct}
                    onClick={() => setQtyKg(String(Math.max(1, Math.round((selected.remainingKg * pct) / 100))))}
                    className="flex-1 rounded border border-ink-500 py-1 text-xs text-ink-300 transition hover:border-tide/60 hover:text-ink-50"
                  >
                    {pct}%
                  </button>
                ))}
              </div>

              <dl className="space-y-1 border-t border-ink-500 pt-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-ink-300">應付金額</dt>
                  <dd className="tnum font-medium text-ink-50">{cost.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} mTWD</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-300">餘額</dt>
                  <dd className={`tnum ${h && cost > Number(h.twd) / 1e6 ? "text-down" : "text-ink-200"}`}>
                    {h ? fmtTwd(h.twd) : "—"} mTWD
                  </dd>
                </div>
              </dl>

              <Button
                onClick={() => buyListing(selected, Number(qtyKg))}
                disabled={!!busy || !qtyKg || Number(qtyKg) < (selected.minFillKg || 1)}
                className="w-full"
              >
                {busy?.startsWith("購買") ? "簽章中…" : "以 passkey 簽章買進"}
              </Button>
            </div>
          )}
        </Card>
      </div>

      <Card title="註銷並取得憑證">
        <div className="mb-4 grid gap-3 md:grid-cols-3">
          <Field label="受益人名稱（憑證上顯示）"><input className={inputCls} value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} placeholder="某某股份有限公司" /></Field>
          <Field label="用途">
            <select className={inputCls} value={purpose} onChange={(e) => setPurpose(Number(e.target.value))}>
              {PURPOSE_LABEL.map((l, i) => <option key={i} value={i}>{l}</option>)}
            </select>
          </Field>
          <Field label="備註"><input className={inputCls} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="FY2025" /></Field>
        </div>
        {!h ? null : (
          <ul className="space-y-2 text-sm">
            {h.batches.map((b) => (
              <li key={b.batchId} className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-500 p-3">
                <span className="flex-1">批次 #{b.batchId} · {b.project} · {b.vintageYear} · 持有 {fmtKg(b.kg)}</span>
                <input className={`${inputCls} w-28`} type="number" min="1" max={b.kg} value={retireKg[`b${b.batchId}`] ?? String(b.kg)} onChange={(e) => setRetireKg({ ...retireKg, [`b${b.batchId}`]: e.target.value })} />
                <Button onClick={() => retireBatch(b.batchId, b.kg)} disabled={!!busy}>註銷</Button>
              </li>
            ))}
            {cctKg > 0 && (
              <li className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-500 p-3">
                <span className="flex-1">池化額度 CCT · 持有 {fmtKg(cctKg)}（註銷時依 FIFO 對應到具體批次）</span>
                <input className={`${inputCls} w-28`} type="number" min="1" max={cctKg} value={retireKg.cct ?? String(cctKg)} onChange={(e) => setRetireKg({ ...retireKg, cct: e.target.value })} />
                <Button onClick={() => retireCct(cctKg)} disabled={!!busy}>註銷</Button>
              </li>
            )}
            {h.batches.length === 0 && cctKg === 0 && <li className="text-ink-300">尚未持有額度。</li>}
          </ul>
        )}
      </Card>
    </div>
  );
}
