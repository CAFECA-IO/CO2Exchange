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
import { outcomeText, useLedger, type WithdrawStatus } from "@/lib/client/ledger";

/// 交易頁的帳本版本（設計 v4 第 3 期）。
///
/// **下單不是鏈上交易**。使用者簽一則委託單訊息（EIP-712），
/// 交易所收進帳本、回一張簽收收據；撮合是重播帳本的結果，每小時一期把整份帳本壓成承諾上鏈。
/// 所以這裡沒有 approve、沒有 gas、沒有「等出塊」——只有簽章。
///
/// 新台幣例外：它是信託專戶裡的真錢，入金是匯款、由營運 Safe 在鏈上確認之後才能在帳本裡買；出金是簽請求、等營運方匯款。

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
  const [payout, setPayout] = useState({ bankCode: "", accountNo: "", holder: "" });
  const [withdrawTwd, setWithdrawTwd] = useState("");
  const [ws, setWs] = useState<WithdrawStatus | null>(null);
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

  // 出金狀態跟著帳本的 head 更新（申請、承諾上鏈、營運方確認之後都會變）
  const wsFetch = lg.withdrawStatus;
  useEffect(() => {
    if (!lg.me) return;
    let ignore = false;
    wsFetch().then((x) => { if (!ignore) setWs(x); }).catch(() => null);
    return () => { ignore = true; };
  }, [lg.me, meSeq, wsFetch]);

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

  const devDeposit = () => run("模擬入金", async () => {
    const amt = BigInt(Math.round(Number(depositTwd) * 1e6));
    if (amt <= 0n) throw new Error("金額要大於零");
    await lg.devDeposit(amt);
    return { kind: "ok", text: `已模擬入金 ${fmtTwd(amt)} 元：營運 Safe 在鏈上確認了這筆匯款，帳本已入帳` };
  });

  const savePayout = () => run("收款帳戶", async () => {
    const r = await lg.setPayoutAccount(payout);
    setPayout({ bankCode: "", accountNo: "", holder: "" });
    return { kind: "ok", text: `收款帳戶已設定：${r.bankCode} ${r.accountNo}（${r.holder}）` };
  });

  const requestWithdraw = () => run("申請出金", async () => {
    const amt = BigInt(Math.round(Number(withdrawTwd) * 1e6));
    if (amt <= 0n) throw new Error("金額要大於零");
    const pa = lg.me?.payoutAccount;
    if (!pa) throw new Error("請先設定收款帳戶");
    const r = await lg.submit("withdraw", { amount: amt.toString() }, {
      title: `申請出金 ${fmtTwd(amt)} 元`,
      detail: `匯到 ${pa.bankCode} ${pa.accountNo}（${pa.holder}）。這筆錢會從可動用移到「待出金」，不能再拿來交易；下一期承諾上鏈之後由營運方匯款並在鏈上確認。`,
    });
    setWithdrawTwd("");
    return outcomeText(r, "出金請求");
  });

  const downloadProof = () => run("證明檔", async () => {
    await lg.downloadProof();
    return { kind: "ok", text: "已下載證明檔。可以拿到 Boltchain Explorer 驗證，或執行 node scripts/verify-proof.mjs <檔案>" };
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
        <Card title="新台幣">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-xs text-ink-300">可動用</dt><dd className="tnum text-lg text-ink-50">{fmtTwd(available)} <span className="text-xs text-ink-300">元</span></dd></div>
            <div><dt className="text-xs text-ink-300">買單鎖定中</dt><dd className="tnum text-lg text-ink-50">{fmtTwd(locked)} <span className="text-xs text-ink-300">元</span></dd></div>
          </dl>

          {lg.me?.deposit && (
            <div className="mt-4 border-t border-ink-700 pt-4" data-testid="deposit">
              <h3 className="text-sm font-semibold text-ink-50">入金</h3>
              <dl className="mt-2 space-y-1 text-xs">
                <div className="flex justify-between gap-3"><dt className="text-ink-300">銀行</dt><dd className="text-right text-ink-100">{lg.me.deposit.trust.bank}{lg.me.deposit.trust.branch && ` ${lg.me.deposit.trust.branch}`}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-ink-300">戶名</dt><dd className="text-right text-ink-100">{lg.me.deposit.trust.accountName}</dd></div>
                {lg.me.deposit.trust.accountNo && <div className="flex justify-between gap-3"><dt className="text-ink-300">帳號</dt><dd className="tnum text-right font-mono text-ink-100">{lg.me.deposit.trust.accountNo}</dd></div>}
                <div className="flex justify-between gap-3"><dt className="text-ink-300">匯款備註（入金識別碼）</dt><dd className="tnum text-right font-mono text-lg text-tide" data-testid="deposit-code">{lg.me.deposit.code}</dd></div>
              </dl>
              <p className="mt-2 text-xs leading-6 text-ink-300">{lg.me.deposit.trust.note}</p>
              {lg.devSigning && (
                <div className="mt-3 flex items-end gap-2">
                  <Field label="模擬入金（本機展示）">
                    <input className={inputCls} inputMode="decimal" value={depositTwd} onChange={(e) => setDepositTwd(e.target.value)} />
                  </Field>
                  <Button onClick={devDeposit} disabled={!!busy}>{busy === "模擬入金" ? "入帳中…" : "模擬入金"}</Button>
                </div>
              )}
            </div>
          )}

          <div className="mt-5 border-t border-ink-700 pt-4" data-testid="withdraw">
            <h3 className="text-sm font-semibold text-ink-50">出金</h3>
            <dl className="mt-2 grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-ink-300">待出金</dt><dd className="tnum text-ink-50">{fmtTwd(BigInt(lg.me?.cash.pendingWithdraw ?? "0"))} <span className="text-xs text-ink-300">元</span></dd></div>
              <div><dt className="text-xs text-ink-300">已進承諾、待匯款</dt><dd className="tnum text-ink-50" data-testid="settleable">{ws ? fmtTwd(BigInt(ws.settleable)) : "—"} <span className="text-xs text-ink-300">元</span></dd></div>
            </dl>
            {ws && BigInt(ws.waitingForCommit) > 0n && (
              <p className="mt-1 text-xs text-ink-300">其中 {fmtTwd(BigInt(ws.waitingForCommit))} 元等下一期承諾上鏈（最長一小時）。</p>
            )}
            {lg.me?.payoutAccount ? (
              <p className="mt-2 text-xs text-ink-200">收款帳戶：{lg.me.payoutAccount.bankCode} {lg.me.payoutAccount.accountNo}（{lg.me.payoutAccount.holder}）</p>
            ) : (
              <p className="mt-2 text-xs text-warn">還沒有設定收款帳戶，無法申請出金。</p>
            )}
            <div className="mt-2 grid grid-cols-3 gap-2">
              <input className={inputCls} placeholder="銀行代碼" value={payout.bankCode} onChange={(e) => setPayout({ ...payout, bankCode: e.target.value })} />
              <input className={inputCls} placeholder="帳號" value={payout.accountNo} onChange={(e) => setPayout({ ...payout, accountNo: e.target.value })} />
              <input className={inputCls} placeholder="戶名" value={payout.holder} onChange={(e) => setPayout({ ...payout, holder: e.target.value })} />
            </div>
            <Button className="mt-2" variant="secondary" onClick={savePayout} disabled={!!busy || !payout.bankCode || !payout.accountNo || !payout.holder}>
              {lg.me?.payoutAccount ? "變更收款帳戶" : "設定收款帳戶"}
            </Button>
            <div className="mt-3 flex items-end gap-2">
              <Field label="申請出金（元）">
                <input className={inputCls} inputMode="decimal" value={withdrawTwd} onChange={(e) => setWithdrawTwd(e.target.value)} placeholder="金額" />
              </Field>
              <Button onClick={requestWithdraw} disabled={!!busy || !withdrawTwd || !lg.me?.payoutAccount}>{busy === "申請出金" ? "簽署中…" : "申請出金"}</Button>
            </div>
            <p className="mt-3 text-xs leading-6 text-ink-300">
              您的新台幣存在信託專戶，平台上的新台幣與碳權都不能提到鏈上錢包。出金分三步：您簽出金請求（錢移到待出金，不能再交易）→
              下一期承諾上鏈 → 營運方匯款到您的收款帳戶並在鏈上確認。鏈上的確認只能銷掉您自己簽過、而且已進承諾的請求。
              帳本欠您多少、鏈上記帳多少，每小時隨承諾公開（見<Link className="underline" href="/custody">託管揭露</Link>）。
            </p>
            <Button variant="secondary" onClick={downloadProof} disabled={!!busy}>{busy === "證明檔" ? "產生中…" : "下載我的證明檔"}</Button>
          </div>
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
              <p className="text-xs text-ink-300">最多支付 {fmtTwd(buyCost)} {CASH}（另加手續費 {fee / 100}%）。沒成交的部分掛在簿子上，鎖住的新台幣隨時可以撤單拿回。</p>
              {buyCost > available && buyKg > 0 && buyPrice > 0 && <Notice kind="warn">可動用的新台幣不夠，請先入金。</Notice>}
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
