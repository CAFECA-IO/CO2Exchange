"use client";
import { useEffect, useState } from "react";
import { useReload } from "@/lib/client/useReload";
import Link from "next/link";
import { encodeFunctionData } from "viem";
import { useAccount } from "@/components/AccountProvider";
import { AccountGate } from "@/components/AccountGate";
import { Button, Card, Field, Notice, fmtKg, fmtTwd, inputCls } from "@/components/ui";
import { erc1155ApprovalAbi, listingWriteAbi, poolWriteAbi, registryWriteAbi } from "@/lib/abis";
import { signAndRelay, type Call } from "@/lib/client/passkey";

type Project = { projectId: number; name: string; methodology: string; location: string; active: boolean };
type Issuance = { id: string; projectId: number; projectName: string; monitoringStart: string; monitoringEnd: string; amountKg: number; reportName: string; reportHash: string; reportFile: string; status: string; reason?: string; batchId?: number; txHash?: string; createdAt: string };
type Holding = { batchId: number; kg: number; vintageYear: number; project: string };
type Order = { orderId: number; seller: string; batchId: number; remainingKg: number; pricePerTonne: string; project: { name: string } };

export default function EnterprisePage() {
  const { credential, config, userId, tier } = useAccount();
  const [projects, setProjects] = useState<Project[]>([]);
  const [issuances, setIssuances] = useState<Issuance[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pf, setPf] = useState({ name: "", methodology: "ISO 14064-2", location: "", metadataURI: "" });
  const [rf, setRf] = useState({ projectId: "", monitoringStart: "2025-01-01", monitoringEnd: "2025-12-31", amountTonnes: "100", note: "" });
  const [report, setReport] = useState<File | null>(null);
  const [listForm, setListForm] = useState<Record<number, { kg: string; price: string; minFill: string }>>({});
  const [depositKg, setDepositKg] = useState<Record<number, string>>({});

  const [reloadKey, reload] = useReload();
  useEffect(() => {
    if (!credential) return;
    const a = credential.address;
    let ignore = false;
    (async () => {
      const [p, i, m] = await Promise.all([
        fetch(`/api/projects?owner=${a}`).then((r) => r.json()),
        fetch(`/api/issuance?owner=${a}`).then((r) => r.json()),
        fetch(`/api/market?account=${a}`).then((r) => r.json()),
      ]);
      if (ignore) return;
      setProjects(p.projects ?? []); setIssuances(i.requests ?? []); setHoldings(m.holdings?.batches ?? []);
      setOrders((m.orders ?? []).filter((o: Order) => o.seller.toLowerCase() === a.toLowerCase()));
    })();
    return () => { ignore = true; };
  }, [credential, reloadKey]);

  if (!userId || !credential || !config) return <AccountGate />;
  if (tier !== 2) return <Notice>企業功能需要法人身分。請到<Link className="underline" href="/kyc">身分驗證</Link>以工商憑證驗證。</Notice>;
  const d = config.deployment;

  async function relay(label: string, calls: Call[]) {
    setBusy(label); setMsg(null);
    try {
      const r = await signAndRelay(config!.rpcUrl, credential!, calls);
      setMsg({ kind: "ok", text: `${label}完成 · tx ${r.txHash.slice(0, 10)}…` });
      reload();
    } catch (e) { setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  }

  function registerProject(e: React.FormEvent) {
    e.preventDefault();
    relay(`登錄專案「${pf.name}」`, [{ target: d.carbonRegistry, value: 0n, data: encodeFunctionData({ abi: registryWriteAbi, functionName: "registerProject", args: [pf.name, pf.methodology, pf.location, pf.metadataURI] }) }]);
  }

  async function submitIssuance(e: React.FormEvent) {
    e.preventDefault();
    if (!report) { setMsg({ kind: "error", text: "請上傳查驗報告 PDF" }); return; }
    setBusy("送出核發申請"); setMsg(null);
    try {
      const fd = new FormData();
      fd.set("projectId", rf.projectId); fd.set("owner", credential!.address);
      fd.set("monitoringStart", rf.monitoringStart); fd.set("monitoringEnd", rf.monitoringEnd); fd.set("amountTonnes", rf.amountTonnes); fd.set("note", rf.note);
      fd.set("report", report);
      const r = await fetch("/api/issuance", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "失敗");
      setMsg({ kind: "ok", text: `核發申請已送出（報告雜湊 ${j.reportHash.slice(0, 12)}…），待查驗機構審核。` });
      setReport(null); reload();
    } catch (e) { setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  }

  function list(h: Holding) {
    const f = listForm[h.batchId] ?? { kg: String(h.kg), price: "800", minFill: "100" };
    const kg = BigInt(Math.min(h.kg, Math.max(1, Math.round(Number(f.kg)))));
    relay(`掛單批次 #${h.batchId} ${fmtKg(Number(kg))}`, [
      { target: d.carbonCredit1155, value: 0n, data: encodeFunctionData({ abi: erc1155ApprovalAbi, functionName: "setApprovalForAll", args: [d.listing, true] }) },
      { target: d.listing, value: 0n, data: encodeFunctionData({ abi: listingWriteAbi, functionName: "list", args: [BigInt(h.batchId), kg, BigInt(Math.round(Number(f.price) * 1e6)), BigInt(Math.max(0, Math.round(Number(f.minFill))))] }) },
    ]);
  }

  function deposit(h: Holding) {
    const kg = BigInt(Math.min(h.kg, Math.max(1, Math.round(Number(depositKg[h.batchId] ?? h.kg)))));
    relay(`入池批次 #${h.batchId} ${fmtKg(Number(kg))}`, [
      { target: d.carbonCredit1155, value: 0n, data: encodeFunctionData({ abi: erc1155ApprovalAbi, functionName: "setApprovalForAll", args: [d.carbonPool, true] }) },
      { target: d.carbonPool, value: 0n, data: encodeFunctionData({ abi: poolWriteAbi, functionName: "deposit", args: [BigInt(h.batchId), kg] }) },
    ]);
  }

  function cancel(o: Order) {
    relay(`取消掛單 #${o.orderId}`, [{ target: d.listing, value: 0n, data: encodeFunctionData({ abi: listingWriteAbi, functionName: "cancel", args: [BigInt(o.orderId)] }) }]);
  }

  const statusLabel: Record<string, string> = { pending: "待查驗", issued: "已核發", rejected: "已退回" };

  return (
    <div className="space-y-6">
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="登錄減量專案">
          <form className="space-y-3" onSubmit={registerProject}>
            <Field label="專案名稱"><input className={inputCls} value={pf.name} onChange={(e) => setPf({ ...pf, name: e.target.value })} required placeholder="屋頂太陽能替代柴油發電" /></Field>
            <Field label="方法學"><input className={inputCls} value={pf.methodology} onChange={(e) => setPf({ ...pf, methodology: e.target.value })} required /></Field>
            <Field label="地點"><input className={inputCls} value={pf.location} onChange={(e) => setPf({ ...pf, location: e.target.value })} required placeholder="Taoyuan, TW" /></Field>
            <Field label="專案文件 URI（選填）"><input className={inputCls} value={pf.metadataURI} onChange={(e) => setPf({ ...pf, metadataURI: e.target.value })} placeholder="ipfs://… 或 https://…" /></Field>
            <Button type="submit" disabled={!!busy}>以 passkey 簽章登錄</Button>
          </form>
        </Card>

        <Card title="申請核發額度（上傳 ISO 14064-3 查驗報告）">
          {projects.length === 0 ? <p className="text-sm text-ink-300">先登錄專案。</p> : (
            <form className="space-y-3" onSubmit={submitIssuance}>
              <Field label="專案">
                <select className={inputCls} value={rf.projectId} onChange={(e) => setRf({ ...rf, projectId: e.target.value })} required>
                  <option value="">選擇專案</option>
                  {projects.filter((p) => p.active).map((p) => <option key={p.projectId} value={p.projectId}>#{p.projectId} {p.name}</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="監測開始"><input className={inputCls} type="date" value={rf.monitoringStart} onChange={(e) => setRf({ ...rf, monitoringStart: e.target.value })} required /></Field>
                <Field label="監測結束"><input className={inputCls} type="date" value={rf.monitoringEnd} onChange={(e) => setRf({ ...rf, monitoringEnd: e.target.value })} required /></Field>
              </div>
              <Field label="申請噸數（tCO₂e）"><input className={inputCls} type="number" min="0.001" step="0.001" value={rf.amountTonnes} onChange={(e) => setRf({ ...rf, amountTonnes: e.target.value })} required /></Field>
              <Field label="查驗報告（PDF）"><input className={inputCls} type="file" accept="application/pdf" onChange={(e) => setReport(e.target.files?.[0] ?? null)} data-testid="report-file" /></Field>
              <Field label="備註"><input className={inputCls} value={rf.note} onChange={(e) => setRf({ ...rf, note: e.target.value })} /></Field>
              <Button type="submit" disabled={!!busy}>送出申請</Button>
            </form>
          )}
        </Card>
      </div>

      <Card title="我的專案與核發申請">
        {projects.length === 0 ? <p className="text-sm text-ink-300">尚無專案。</p> : (
          <ul className="space-y-2 text-sm">
            {projects.map((p) => (
              <li key={p.projectId} className="rounded-lg border border-ink-500 p-3">
                <div className="font-medium">#{p.projectId} {p.name} <span className="text-xs text-ink-300">{p.methodology} · {p.location}{!p.active && " · 已停用"}</span></div>
                <ul className="mt-1 space-y-1 text-xs text-ink-300">
                  {issuances.filter((i) => i.projectId === p.projectId).map((i) => (
                    <li key={i.id} data-testid="issuance-row">
                      {i.monitoringStart} ~ {i.monitoringEnd} · {fmtKg(i.amountKg)} · <a className="underline" href={`/api/uploads/${i.reportFile}`} target="_blank">{i.reportName}</a> · <b>{statusLabel[i.status]}</b>
                      {i.status === "issued" && ` · 批次 #${i.batchId}`}{i.status === "rejected" && `：${i.reason}`}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="我的額度批次：掛單或入池">
        {holdings.length === 0 ? <p className="text-sm text-ink-300">尚未持有額度。</p> : (
          <ul className="space-y-3 text-sm">
            {holdings.map((h) => {
              const f = listForm[h.batchId] ?? { kg: String(h.kg), price: "800", minFill: "100" };
              return (
                <li key={h.batchId} className="rounded-lg border border-ink-500 p-3" data-testid="holding-row">
                  <div className="mb-2 font-medium">批次 #{h.batchId} · {h.project} · {h.vintageYear} · 持有 {fmtKg(h.kg)}</div>
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="掛單 kg"><input className={`${inputCls} w-28`} type="number" value={f.kg} onChange={(e) => setListForm({ ...listForm, [h.batchId]: { ...f, kg: e.target.value } })} /></Field>
                    <Field label="mTWD / 噸"><input className={`${inputCls} w-28`} type="number" value={f.price} onChange={(e) => setListForm({ ...listForm, [h.batchId]: { ...f, price: e.target.value } })} /></Field>
                    <Field label="最小成交 kg"><input className={`${inputCls} w-28`} type="number" value={f.minFill} onChange={(e) => setListForm({ ...listForm, [h.batchId]: { ...f, minFill: e.target.value } })} /></Field>
                    <Button onClick={() => list(h)} disabled={!!busy}>掛單</Button>
                    <span className="mx-2 text-ink-300">|</span>
                    <Field label="入池 kg"><input className={`${inputCls} w-28`} type="number" value={depositKg[h.batchId] ?? String(h.kg)} onChange={(e) => setDepositKg({ ...depositKg, [h.batchId]: e.target.value })} /></Field>
                    <Button variant="secondary" onClick={() => deposit(h)} disabled={!!busy}>入池換 CCT</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="我的掛單">
        {orders.length === 0 ? <p className="text-sm text-ink-300">沒有進行中的掛單。</p> : (
          <ul className="space-y-2 text-sm">
            {orders.map((o) => (
              <li key={o.orderId} className="flex items-center gap-3 rounded-lg border border-ink-500 p-3">
                <span className="flex-1">掛單 #{o.orderId} · 批次 #{o.batchId} · 剩餘 {fmtKg(o.remainingKg)} · {fmtTwd(o.pricePerTonne)} mTWD / 噸</span>
                <Button variant="secondary" onClick={() => cancel(o)} disabled={!!busy}>取消</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
