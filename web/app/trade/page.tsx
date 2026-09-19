"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { encodeFunctionData, keccak256, toBytes, type Address, type Hex } from "viem";
import { useAccount } from "@/components/AccountProvider";
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
  const [kgByOrder, setKgByOrder] = useState<Record<number, string>>({});
  const [twdIn, setTwdIn] = useState("2000");
  const [beneficiary, setBeneficiary] = useState("");
  const [purpose, setPurpose] = useState(1);
  const [memo, setMemo] = useState("");
  const [retireKg, setRetireKg] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/market${credential ? `?account=${credential.address}` : ""}`);
    if (r.ok) setM(await r.json());
  }, [credential]);
  useEffect(() => { refresh(); }, [refresh]);

  if (!userId) return <Notice>請先在<Link className="underline" href="/">首頁</Link>登入。</Notice>;
  if (!credential || !config) return <Notice>請先在<Link className="underline" href="/">首頁</Link>建立鏈上帳戶。</Notice>;
  const d = config.deployment;

  async function relay(label: string, calls: Call[]) {
    setBusy(label); setMsg(null);
    try {
      const r = await signAndRelay(config!.rpcUrl, credential!, calls);
      setMsg({ kind: "ok", text: `${label}完成 · tx ${r.txHash.slice(0, 10)}… · gas ${Number(r.gasUsed).toLocaleString()}（平台代付）` });
      await refresh();
    } catch (e) {
      console.error("relay failed", e);
      setMsg({ kind: "error", text: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    } finally { setBusy(null); }
  }

  async function faucet() {
    setBusy("領取"); setMsg(null);
    try { await fetch("/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: credential!.address }) }); await refresh(); }
    finally { setBusy(null); }
  }

  function buyListing(o: Order) {
    const kg = BigInt(Math.max(1, Math.round(Number(kgByOrder[o.orderId] ?? "1000"))));
    const cost = (kg * BigInt(o.pricePerTonne)) / 1000n;
    relay(`掛單購買 ${fmtKg(Number(kg))}`, [
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

  return (
    <div className="space-y-6">
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div className="grid gap-6 md:grid-cols-3">
        <Card title="我的餘額">
          {h ? (
            <dl className="space-y-1 text-sm">
              <div><dt className="text-zinc-500">結算幣 mTWD</dt><dd data-testid="twd">{fmtTwd(h.twd)}</dd></div>
              <div><dt className="text-zinc-500">池化額度 CCT</dt><dd data-testid="cct">{fmtKg(cctKg)}</dd></div>
              <div><dt className="text-zinc-500">批次額度</dt><dd data-testid="batches">{h.batches.length ? h.batches.map((b) => `#${b.batchId} ${fmtKg(b.kg)}`).join("、") : "—"}</dd></div>
            </dl>
          ) : <p className="text-sm text-zinc-500">讀取中…</p>}
          <div className="mt-3"><Button variant="secondary" onClick={faucet} disabled={!!busy}>領取測試用 mTWD</Button></div>
        </Card>

        {(!m || m.poolKey) && (
          <Card title="流動性池（Uniswap v4，展示）" className="md:col-span-2">
            <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
              現貨參考價 {m?.spotPricePerTonne ? `${m.spotPricePerTonne.toLocaleString("zh-TW", { maximumFractionDigits: 0 })} mTWD / 噸` : "—"}（不含 0.3% 手續費與滑價）
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="支付 mTWD"><input className={inputCls} type="number" min="1" value={twdIn} onChange={(e) => setTwdIn(e.target.value)} /></Field>
              <Button onClick={buyPool} disabled={!!busy || !m}>{busy?.startsWith("流動性池") ? "簽章中…" : "以 passkey 簽章購買"}</Button>
            </div>
          </Card>
        )}
      </div>

      <Card title="企業掛單">
        {!m ? <p className="text-sm text-zinc-500">讀取中…</p> : m.orders.length === 0 ? <p className="text-sm text-zinc-500">目前沒有掛單。</p> : (
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500"><tr><th className="py-1">專案</th><th>年份</th><th>剩餘</th><th>價格 / 噸</th><th>購買數量 (kg)</th><th></th></tr></thead>
            <tbody>
              {m.orders.map((o) => (
                <tr key={o.orderId} className="border-t border-zinc-200 dark:border-zinc-800">
                  <td className="py-2"><div>{o.project.name}</div><div className="text-xs text-zinc-500">{o.project.methodology} · {o.project.location} · 批次 #{o.batchId}</div></td>
                  <td>{o.vintageYear}</td>
                  <td>{fmtKg(o.remainingKg)}</td>
                  <td>{fmtTwd(o.pricePerTonne)} mTWD</td>
                  <td><input className={`${inputCls} w-28`} type="number" min={o.minFillKg || 1} max={o.remainingKg} value={kgByOrder[o.orderId] ?? "1000"} onChange={(e) => setKgByOrder({ ...kgByOrder, [o.orderId]: e.target.value })} /></td>
                  <td className="text-right"><Button onClick={() => buyListing(o)} disabled={!!busy}>購買</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {m && <p className="mt-2 text-xs text-zinc-500">平台手續費 {m.listingFeeBps / 100}%，由賣方承擔。</p>}
      </Card>

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
              <li key={b.batchId} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                <span className="flex-1">批次 #{b.batchId} · {b.project} · {b.vintageYear} · 持有 {fmtKg(b.kg)}</span>
                <input className={`${inputCls} w-28`} type="number" min="1" max={b.kg} value={retireKg[`b${b.batchId}`] ?? String(b.kg)} onChange={(e) => setRetireKg({ ...retireKg, [`b${b.batchId}`]: e.target.value })} />
                <Button onClick={() => retireBatch(b.batchId, b.kg)} disabled={!!busy}>註銷</Button>
              </li>
            ))}
            {cctKg > 0 && (
              <li className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                <span className="flex-1">池化額度 CCT · 持有 {fmtKg(cctKg)}（註銷時依 FIFO 對應到具體批次）</span>
                <input className={`${inputCls} w-28`} type="number" min="1" max={cctKg} value={retireKg.cct ?? String(cctKg)} onChange={(e) => setRetireKg({ ...retireKg, cct: e.target.value })} />
                <Button onClick={() => retireCct(cctKg)} disabled={!!busy}>註銷</Button>
              </li>
            )}
            {h.batches.length === 0 && cctKg === 0 && <li className="text-zinc-500">尚未持有額度。</li>}
          </ul>
        )}
      </Card>
    </div>
  );
}
