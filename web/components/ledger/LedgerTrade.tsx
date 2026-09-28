"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount, useCash } from "@/components/AccountProvider";
import { AccountGate } from "@/components/AccountGate";
import { AgreementCheck, useAgreementGate } from "@/components/AgreementGate";
import { ParticipantBadge } from "@/components/ParticipantBadge";
import { Button, Card, Field, Notice, fmtKg, fmtTwd, inputCls } from "@/components/ui";
import { flagOf } from "@/lib/deployment";
import { fetchJson } from "@/lib/client/fetchJson";
import { outcomeText, useLedger } from "@/lib/client/ledger";

/// 交易頁的帳本版本（設計 v4 第 3 期）。
///
/// 和舊版最大的差別：**下單不是鏈上交易**。使用者簽一則委託單訊息（EIP-712），
/// 交易所收進帳本、回一張簽收收據；撮合是重播帳本的結果，每小時一期把整份帳本壓成承諾上鏈。
/// 所以這裡沒有 approve、沒有 gas、沒有「等出塊」——只有簽章。
///
/// 結算幣例外：它是鏈上資產，要先存進帳本合約（一筆鏈上交易），之後才能在帳本裡買。

type Ask = {
  orderId: number; seller: string; batchId: number; remainingKg: number; pricePerTonne: string; minFillKg: number;
  project: { name: string; methodology: string; location: string }; vintageYear: number; country: string; scheme: string; domestic: boolean;
  tag?: "mm" | "sim" | "op" | null;
};
type Bid = { bidId: number; buyer: string; country: string; remainingKg: number; pricePerTonne: string; minFillKg: number; tag?: "mm" | "sim" | "op" | null };
type Batch = { batchId: number; kg: number; vintageYear: number; project: string; country: string; scheme: string };
type Market = { orders: Ask[]; bids: Bid[]; listingFeeBps: number; holdings: { twd: string; batches: Batch[] } | null };

const toKg = (t: string) => Math.round(Number(t) * 1000);
const toMicro = (p: string) => Math.round(Number(p) * 1e6);

export function LedgerTrade() {
  const { wallet, channelOpen, config, userId, tier } = useAccount();
  const CASH = useCash();
  const lg = useLedger();
  const [m, setM] = useState<Market | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [buy, setBuy] = useState({ country: "TW", batchId: 0, tonnes: "1", price: "" });
  const [sell, setSell] = useState({ batchId: 0, tonnes: "1", price: "" });
  const [depositTwd, setDepositTwd] = useState("100000");
  const buyGate = useAgreementGate(wallet?.address, ["platform-terms", "trade-agreement"]);
  const sellGate = useAgreementGate(wallet?.address, ["platform-terms", "service-fee", "trade-agreement"]);

  const meSeq = lg.me?.head.seq;
  useEffect(() => {
    let ignore = false;
    fetchJson<Market>(`/api/market${wallet ? `?account=${wallet.address}` : ""}`)
      .then((j) => { if (!ignore) setM(j); })
      .catch(() => null);
    return () => { ignore = true; };
  }, [wallet, meSeq]);

  if (!userId || !wallet || !config) return <AccountGate />;
  // 開發用登入沒有 CAFECA 通道，由伺服器代簽；正式登入要開通道才簽得出委託單
  if (!channelOpen && !lg.devSigning) {
    if (!lg.me) return <Card title="交易"><Notice>讀取帳本中…</Notice></Card>;
    return <AccountGate />;
  }

  async function run(label: string, fn: () => Promise<{ kind: "ok" | "error"; text: string } | void>) {
    setBusy(label); setMsg(null);
    try {
      const r = await fn();
      if (r) setMsg(r);
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(null); }
  }

  const available = BigInt(lg.me?.cash.available ?? "0");
  const locked = BigInt(lg.me?.cash.locked ?? "0");
  const asks = m?.orders ?? [];
  const bids = m?.bids ?? [];
  const batches = m?.holdings?.batches ?? [];
  const countries = [...new Set(["TW", ...asks.map((a) => a.country)])];
  const fee = m?.listingFeeBps ?? 0;

  const buyKg = toKg(buy.tonnes);
  const buyPrice = toMicro(buy.price);
  const buyCost = BigInt(buyKg) * BigInt(buyPrice) / 1000n;
  const buyReady = buyKg > 0 && buyPrice > 0 && buyCost <= available && buyGate.ok && tier > 0;

  const sb = batches.find((b) => b.batchId === sell.batchId) ?? batches[0];
  const sellKg = Math.min(sb?.kg ?? 0, toKg(sell.tonnes));
  const sellPrice = toMicro(sell.price);
  const sellReady = !!sb && sellKg > 0 && sellPrice > 0 && sellGate.ok && tier > 0;

  const placeBuy = () => run("掛買單", async () => {
    await buyGate.accept("ledger:place-buy");
    const r = await lg.submit("place", {
      side: "buy", batchId: buy.batchId, country: buy.batchId ? "" : buy.country,
      amountKg: buyKg, pricePerTonne: buyPrice, minFillKg: 0,
    }, {
      title: `買進 ${fmtKg(buyKg)}，每噸 ${buy.price} 元`,
      detail: `${buy.batchId ? `批次 #${buy.batchId}` : `${buy.country} 任一批次`}；最多支付 ${fmtTwd(buyCost)} ${CASH}（另加手續費 ${fee / 100}%）。委託單記進帳本，不是鏈上交易。`,
    });
    return outcomeText(r, "買單");
  });

  const placeSell = () => run("掛賣單", async () => {
    await sellGate.accept("ledger:place-sell");
    const r = await lg.submit("place", {
      side: "sell", batchId: sb!.batchId, country: "", amountKg: sellKg, pricePerTonne: sellPrice, minFillKg: 0,
    }, {
      title: `賣出批次 #${sb!.batchId} ${fmtKg(sellKg)}，每噸 ${sell.price} 元`,
      detail: `${sb!.project}（${sb!.country} ${sb!.vintageYear}）。委託單記進帳本，不是鏈上交易。`,
    });
    return outcomeText(r, "賣單");
  });

  const cancel = (seq: string) => run(`撤單 #${seq}`, async () => {
    const r = await lg.submit("cancel", { orderSeq: seq }, { title: `撤銷委託單 #${seq}`, detail: "未成交的部分退回可動用餘額。" });
    return outcomeText(r, "撤單");
  });

  const deposit = () => run("存入", async () => {
    const amt = BigInt(Math.round(Number(depositTwd) * 1e6));
    if (amt <= 0n) throw new Error("金額要大於零");
    await lg.deposit(amt);
    return { kind: "ok", text: `已存入 ${fmtTwd(amt)} ${CASH}，帳本已記下這筆鏈上存入` };
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-tide">交易 · 帳本</p>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-ink-50">買進與賣出</h1>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/portfolio" className="rounded-[--radius-ctl] border border-ink-500 px-3 py-1.5 text-ink-200 transition hover:border-tide/60">我的資產</Link>
          <Link href="/retire" className="rounded-[--radius-ctl] border border-ink-500 px-3 py-1.5 text-ink-200 transition hover:border-tide/60">註銷</Link>
        </div>
      </div>

      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {lg.devSigning && (
        <Notice kind="warn">開發用登入：委託單由伺服器以這個帳戶推出來的測試金鑰代簽（只在本機測試鏈）。簽出來的是真的簽章，查核時照樣驗得過。</Notice>
      )}
      {tier === 0 && (
        <Notice>
          <span data-testid="need-kyc">下單前要先完成<Link className="underline" href="/kyc">身分驗證</Link>。</span>
        </Notice>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
        <Card title="帳本裡的結算幣">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-xs text-ink-300">可動用</dt><dd className="tnum text-lg text-ink-50">{fmtTwd(available)} <span className="text-xs text-ink-300">{CASH}</span></dd></div>
            <div><dt className="text-xs text-ink-300">買單鎖定中</dt><dd className="tnum text-lg text-ink-50">{fmtTwd(locked)} <span className="text-xs text-ink-300">{CASH}</span></dd></div>
          </dl>
          {lg.me?.wallet && (
            <dl className="mt-3 space-y-1 border-t border-ink-700 pt-3 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-300">錢包裡（可存入）</dt>
                <dd className="tnum text-ink-100" data-testid="wallet-cash">
                  {lg.me.wallet.balance === null ? "讀不到" : `${fmtTwd(BigInt(lg.me.wallet.balance))} ${CASH}`}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-300">結算幣合約</dt>
                <dd className="break-all text-right font-mono text-ink-200" title={lg.me.wallet.settlementToken}>{lg.me.wallet.settlementToken}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-300">存入對象（帳本合約）</dt>
                <dd className="break-all text-right font-mono text-ink-200" title={lg.me.wallet.ledger}>{lg.me.wallet.ledger}</dd>
              </div>
            </dl>
          )}
          <div className="mt-4 flex items-end gap-2">
            <Field label={`存入金額（${CASH}）`}>
              <input className={inputCls} inputMode="decimal" value={depositTwd} onChange={(e) => setDepositTwd(e.target.value)} />
            </Field>
            <Button onClick={deposit} disabled={!!busy}>{busy === "存入" ? "存入中…" : "存入帳本"}</Button>
          </div>
          <p className="mt-3 text-xs leading-6 text-ink-300">
            結算幣是鏈上資產：存入是一筆鏈上轉帳，轉進帳本合約託管；之後的買賣只是帳本更新，不必等出塊、不付 gas。
            帳本欠您多少，每小時隨承諾上鏈，可與合約實際持有對照（見<Link className="underline" href="/custody">託管揭露</Link>）。
          </p>
        </Card>

        <Card title="下單">
          <div className="mb-4 flex gap-2">
            {(["buy", "sell"] as const).map((s) => (
              <Button key={s} variant={side === s ? "primary" : "secondary"} onClick={() => setSide(s)}>{s === "buy" ? "買進" : "賣出"}</Button>
            ))}
          </div>
          {side === "buy" ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="核發國">
                  <select className={inputCls} value={buy.batchId ? `b${buy.batchId}` : buy.country}
                    onChange={(e) => setBuy({ ...buy, country: e.target.value.startsWith("b") ? buy.country : e.target.value, batchId: e.target.value.startsWith("b") ? Number(e.target.value.slice(1)) : 0 })}>
                    {countries.map((c) => <option key={c} value={c}>{flagOf(c)} {c} 任一批次</option>)}
                    {buy.batchId > 0 && <option value={`b${buy.batchId}`}>指定批次 #{buy.batchId}</option>}
                  </select>
                </Field>
                <Field label="數量（噸）"><input className={inputCls} inputMode="decimal" value={buy.tonnes} onChange={(e) => setBuy({ ...buy, tonnes: e.target.value })} /></Field>
              </div>
              <Field label="每噸最高價（元）"><input className={inputCls} inputMode="decimal" placeholder={asks[0] ? String(Number(asks[0].pricePerTonne) / 1e6) : ""} value={buy.price} onChange={(e) => setBuy({ ...buy, price: e.target.value })} /></Field>
              <p className="text-xs text-ink-300">最多支付 {fmtTwd(buyCost)} {CASH}（另加手續費 {fee / 100}%）。沒成交的部分掛在簿子上，鎖住的結算幣隨時可以撤單拿回。</p>
              {buyCost > available && buyKg > 0 && buyPrice > 0 && <Notice kind="warn">可動用的結算幣不夠，請先存入。</Notice>}
              <AgreementCheck gate={buyGate} />
              <Button onClick={placeBuy} disabled={!buyReady || !!busy}>{busy === "掛買單" ? "送出中…" : "簽署並送出買單"}</Button>
            </div>
          ) : batches.length === 0 ? (
            <Notice>帳本裡沒有可賣的批次。</Notice>
          ) : (
            <div className="space-y-3">
              <Field label="批次">
                <select className={inputCls} value={sb?.batchId ?? 0} onChange={(e) => setSell({ ...sell, batchId: Number(e.target.value) })}>
                  {batches.map((b) => <option key={b.batchId} value={b.batchId}>{flagOf(b.country)} #{b.batchId} {b.project} {b.vintageYear}（持有 {fmtKg(b.kg)}）</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="數量（噸）"><input className={inputCls} inputMode="decimal" value={sell.tonnes} onChange={(e) => setSell({ ...sell, tonnes: e.target.value })} /></Field>
                <Field label="每噸最低價（元）"><input className={inputCls} inputMode="decimal" placeholder={bids[0] ? String(Number(bids[0].pricePerTonne) / 1e6) : ""} value={sell.price} onChange={(e) => setSell({ ...sell, price: e.target.value })} /></Field>
              </div>
              <AgreementCheck gate={sellGate} />
              <Button onClick={placeSell} disabled={!sellReady || !!busy}>{busy === "掛賣單" ? "送出中…" : "簽署並送出賣單"}</Button>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="賣單（由低到高）">
          {asks.length === 0 ? <p className="text-sm text-ink-300">目前沒有賣單。</p> : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-300"><tr><th className="py-1">批次</th><th className="text-right">剩餘</th><th className="text-right">每噸</th><th /></tr></thead>
              <tbody>{asks.slice(0, 15).map((a) => (
                <tr key={a.orderId} className="border-t border-ink-600">
                  <td className="py-1.5">
                    <span className="mr-1">{flagOf(a.country)}</span>#{a.batchId} <span className="text-ink-300">{a.project.name} {a.vintageYear}</span>
                    {a.tag && <ParticipantBadge tag={a.tag} />}
                  </td>
                  <td className="tnum text-right">{fmtKg(a.remainingKg)}</td>
                  <td className="tnum text-right">{fmtTwd(a.pricePerTonne)}</td>
                  <td className="text-right">
                    <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => { setSide("buy"); setBuy({ country: a.country, batchId: a.batchId, tonnes: String(a.remainingKg / 1000), price: String(Number(a.pricePerTonne) / 1e6) }); }}>買這張</Button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
        <Card title="買單（由高到低）">
          {bids.length === 0 ? <p className="text-sm text-ink-300">目前沒有買單。</p> : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-300"><tr><th className="py-1">核發國</th><th className="text-right">剩餘</th><th className="text-right">每噸</th></tr></thead>
              <tbody>{bids.slice(0, 15).map((b) => (
                <tr key={b.bidId} className="border-t border-ink-600">
                  <td className="py-1.5">{b.country ? <>{flagOf(b.country)} {b.country}</> : "指定批次"} {b.tag && <ParticipantBadge tag={b.tag} />}</td>
                  <td className="tnum text-right">{fmtKg(b.remainingKg)}</td>
                  <td className="tnum text-right">{fmtTwd(b.pricePerTonne)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="我的委託單">
        {!lg.me || lg.me.orders.length === 0 ? <p className="text-sm text-ink-300">沒有掛著的委託單。</p> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-300"><tr><th className="py-1">序號</th><th>方向</th><th>標的</th><th className="text-right">剩餘／原始</th><th className="text-right">每噸</th><th /></tr></thead>
            <tbody>{lg.me.orders.map((o) => (
              <tr key={o.seq} className="border-t border-ink-600">
                <td className="tnum py-1.5">#{o.seq}</td>
                <td className={o.side === "buy" ? "text-tide" : "text-down"}>{o.side === "buy" ? "買" : "賣"}</td>
                <td>{o.batchId !== "0" ? `批次 #${o.batchId}` : `${flagOf(o.country)} ${o.country} 任一批次`}</td>
                <td className="tnum text-right">{fmtKg(Number(o.remainingKg))}／{fmtKg(Number(o.amountKg))}</td>
                <td className="tnum text-right">{fmtTwd(o.pricePerTonne)}</td>
                <td className="text-right"><Button variant="ghost" className="px-2 py-1 text-xs" disabled={!!busy} onClick={() => cancel(o.seq)}>撤單</Button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>

      <Card title="我的成交">
        {!lg.me || lg.me.fills.length === 0 ? <p className="text-sm text-ink-300">還沒有成交。</p> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-300"><tr><th className="py-1">時間</th><th>方向</th><th>批次</th><th className="text-right">數量</th><th className="text-right">每噸</th><th className="text-right">手續費</th></tr></thead>
            <tbody>{lg.me.fills.map((f) => {
              const mine = f.buyer.toLowerCase() === wallet.address.toLowerCase() ? "買" : "賣";
              return (
                <tr key={`${f.atSeq}-${f.batchId}-${f.buyer}-${f.seller}`} className="border-t border-ink-600">
                  <td className="py-1.5 text-xs text-ink-300">{new Date(Number(f.at) * 1000).toLocaleString("zh-TW")}</td>
                  <td>{mine}</td>
                  <td>#{f.batchId}</td>
                  <td className="tnum text-right">{fmtKg(Number(f.amountKg))}</td>
                  <td className="tnum text-right">{fmtTwd(f.pricePerTonne)}</td>
                  <td className="tnum text-right">{fmtTwd(f.fee)}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
        <p className="mt-3 text-xs leading-6 text-ink-300">
          成交不是交易所寫進去的結果，而是重播帳本裡所有委託單算出來的。每一期承諾上鏈之後，任何人拿到帳本都能重算一次。
        </p>
      </Card>
    </div>
  );
}
