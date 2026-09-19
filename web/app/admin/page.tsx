"use client";
import { useCallback, useEffect, useState } from "react";
import { useAccount } from "@/components/AccountProvider";
import { Button, Card, Notice, fmtKg } from "@/components/ui";
import { PURPOSE_LABEL, TIER_LABEL } from "@/lib/deployment";

type KycReq = { id: string; account: string; tier: number; idNumberMasked: string; name: string; email: string; status: string; reason?: string; txHash?: string; createdAt: string; decidedBy?: string };
type Cert = { certId: number; batchId: number; amountKg: number; beneficiary: string; purpose: number; retiredAt: number; owner: string; pdfHash: string | null; onchainHash: string | null; anchored: boolean };
type Gov = {
  matrix: { name: string; address: string; admin: boolean; sovereign: boolean | null; operator: boolean | null }[];
  hasV4: boolean;
  poolManagerOwner: string | null; poolManagerOwnerIsTimelock: boolean; listingPaused: boolean; poolPaused: boolean; trustedRouter: string | null; swapsEnabled: boolean;
  nationalSafe: { address: string; owners: string[]; threshold: number }; operatorSafe: { address: string; owners: string[]; threshold: number };
  timelock: { address: string; delay: number; proposer: boolean; executor: boolean; canceller: boolean; operations: { id: string; target: string; data: string; state: string; readyAt: number; txHash: string }[] };
};

const tabs = ["KYC 審核", "憑證文件", "治理狀態"] as const;

export default function AdminPage() {
  const { me } = useAccount();
  const [tab, setTab] = useState<(typeof tabs)[number]>("KYC 審核");
  const [kyc, setKyc] = useState<KycReq[]>([]);
  const [certs, setCerts] = useState<Cert[]>([]);
  const [gov, setGov] = useState<Gov | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const [k, c, g] = await Promise.all([fetch("/api/kyc/queue"), fetch("/api/certificates/all"), fetch("/api/governance")]);
    if (k.ok) setKyc((await k.json()).requests ?? []);
    if (c.ok) setCerts((await c.json()).certificates ?? []);
    if (g.ok) setGov(await g.json());
  }, []);
  useEffect(() => { if (me.isAdmin) refresh(); }, [me.isAdmin, refresh]);

  if (!me.isAdmin) return <Notice>此頁面限管理員帳號。</Notice>;

  async function act(label: string, fn: () => Promise<Response>) {
    setBusy(label); setMsg(null);
    try {
      const r = await fn(); const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "失敗");
      setMsg({ kind: "ok", text: `${label}完成${j.txHash ? ` · tx ${j.txHash.slice(0, 10)}…` : ""}${j.sha256 ? ` · SHA-256 ${j.sha256.slice(0, 14)}…` : ""}` });
      await refresh();
    } catch (e) { setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  }
  const post = (url: string, body?: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const Bool = ({ v }: { v: boolean | null }) => v === null ? <span className="text-zinc-400">—</span> : <span className={v ? "text-emerald-600" : "font-semibold text-red-600"}>{v ? "✓" : "✗"}</span>;

  const pendingKyc = kyc.filter((r) => r.status === "pending");

  return (
    <div className="space-y-4">
      <div className="flex gap-2">{tabs.map((t) => <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-sm ${tab === t ? "bg-emerald-600 text-white" : "border border-zinc-300 dark:border-zinc-700"}`}>{t}</button>)}</div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      {tab === "KYC 審核" && (
        <Card title={`待審核（${pendingKyc.length}）`}>
          <p className="mb-3 text-xs text-zinc-500">核准 = 身分驗證服務簽發 attestation 並上鏈。正式環境此處為憑證鏈驗證結果，不是人工按鈕。</p>
          {pendingKyc.length === 0 ? <p className="text-sm text-zinc-500">沒有待審申請。</p> : (
            <ul className="space-y-2 text-sm">
              {pendingKyc.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800" data-testid="kyc-row">
                  <div className="flex-1">
                    <div>{TIER_LABEL[r.tier]} · {r.name || "—"} · {r.idNumberMasked} · {r.email}</div>
                    <div className="font-mono text-xs text-zinc-500">{r.account}</div>
                  </div>
                  <Button onClick={() => act("核准", () => post("/api/kyc/decide", { id: r.id, approve: true }))} disabled={!!busy}>核准</Button>
                  <input className="w-40 rounded-lg border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950" placeholder="退回原因" value={reason[r.id] ?? ""} onChange={(e) => setReason({ ...reason, [r.id]: e.target.value })} />
                  <Button variant="secondary" onClick={() => act("退回", () => post("/api/kyc/decide", { id: r.id, approve: false, reason: reason[r.id] ?? "" }))} disabled={!!busy}>退回</Button>
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-5 mb-2 text-sm font-semibold">歷史</h3>
          <table className="w-full text-xs">
            <thead className="text-left text-zinc-500"><tr><th className="py-1">時間</th><th>帳戶</th><th>類型</th><th>結果</th><th>處理者</th></tr></thead>
            <tbody>{kyc.filter((r) => r.status !== "pending").map((r) => (
              <tr key={r.id} className="border-t border-zinc-200 dark:border-zinc-800"><td className="py-1">{new Date(r.createdAt).toLocaleString("zh-TW")}</td><td className="font-mono">{r.account.slice(0, 10)}…</td><td>{TIER_LABEL[r.tier]}</td><td>{r.status === "approved" ? "核准" : `退回：${r.reason || "—"}`}</td><td>{r.decidedBy}</td></tr>
            ))}</tbody>
          </table>
        </Card>
      )}

      {tab === "憑證文件" && (
        <Card title="註銷憑證 PDF 與鏈上雜湊回寫">
          <p className="mb-3 text-xs text-zinc-500">流程：產生 PDF → 檔案 SHA-256 → 以 DOCUMENT_ROLE 金鑰回寫 <code>documentHash</code>。回寫後不可重新產生。</p>
          {certs.length === 0 ? <p className="text-sm text-zinc-500">尚無憑證。</p> : (
            <table className="w-full text-sm">
              <thead className="text-left text-zinc-500"><tr><th className="py-1">#</th><th>受益人</th><th>數量</th><th>用途</th><th>PDF</th><th>鏈上</th><th></th></tr></thead>
              <tbody>{certs.map((c) => (
                <tr key={c.certId} className="border-t border-zinc-200 dark:border-zinc-800" data-testid="cert-row">
                  <td className="py-2">{c.certId}</td><td>{c.beneficiary || "—"}</td><td>{fmtKg(c.amountKg)}</td><td>{PURPOSE_LABEL[c.purpose]}</td>
                  <td className="font-mono text-xs">{c.pdfHash ? <a className="underline" href={`/api/certificates/${c.certId}/pdf`} target="_blank">{c.pdfHash.slice(0, 12)}…</a> : "—"}</td>
                  <td className="font-mono text-xs">{c.onchainHash ? `${c.onchainHash.slice(0, 12)}…` : "—"} {c.anchored && <span className="text-emerald-600">✓</span>}</td>
                  <td className="text-right">
                    {!c.onchainHash && <Button variant="secondary" onClick={() => act(`產生 PDF #${c.certId}`, () => post(`/api/certificates/${c.certId}/pdf`))} disabled={!!busy}>{c.pdfHash ? "重新產生" : "產生 PDF"}</Button>}
                    {c.pdfHash && !c.onchainHash && <span className="ml-2"><Button onClick={() => act(`回寫 #${c.certId}`, () => post(`/api/certificates/${c.certId}/anchor`))} disabled={!!busy}>回寫鏈上</Button></span>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
      )}

      {tab === "治理狀態" && (gov ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="角色矩陣" className="md:col-span-2">
            <table className="w-full text-sm">
              <thead className="text-left text-zinc-500"><tr><th className="py-1">合約</th><th>admin = Timelock</th><th>sovereign = 國家 Safe</th><th>operator = 營運 Safe</th></tr></thead>
              <tbody>{gov.matrix.map((m) => (
                <tr key={m.name} className="border-t border-zinc-200 dark:border-zinc-800"><td className="py-1">{m.name} <span className="font-mono text-xs text-zinc-400">{m.address.slice(0, 8)}…</span></td><td><Bool v={m.admin} /></td><td><Bool v={m.sovereign} /></td><td><Bool v={m.operator} /></td></tr>
              ))}</tbody>
            </table>
            <p className="mt-2 text-xs">
              Listing 暫停 {gov.listingPaused ? "是" : "否"} · Pool 暫停 {gov.poolPaused ? "是" : "否"}
              {gov.hasV4
                ? <> · PoolManager owner = Timelock <Bool v={gov.poolManagerOwnerIsTimelock} /> · v4 swap {gov.swapsEnabled ? "開啟" : "關閉"}</>
                : <> · v4 模組未部署（此鏈不支援 EIP-1153，以 SKIP_V4 部署）</>}
            </p>
          </Card>
          <Card title={`國家單位 Safe（${gov.nationalSafe.threshold}-of-${gov.nationalSafe.owners.length}）`}>
            <div className="font-mono text-xs break-all">{gov.nationalSafe.address}</div>
            <ul className="mt-2 font-mono text-xs">{gov.nationalSafe.owners.map((o) => <li key={o}>{o}</li>)}</ul>
          </Card>
          <Card title={`營運 Safe（${gov.operatorSafe.threshold}-of-${gov.operatorSafe.owners.length}）`}>
            <div className="font-mono text-xs break-all">{gov.operatorSafe.address}</div>
            <ul className="mt-2 font-mono text-xs">{gov.operatorSafe.owners.map((o) => <li key={o}>{o}</li>)}</ul>
          </Card>
          <Card title={`Timelock（延遲 ${gov.timelock.delay / 3600} 小時）`} className="md:col-span-2">
            <p className="text-xs">proposer <Bool v={gov.timelock.proposer} /> executor <Bool v={gov.timelock.executor} /> canceller <Bool v={gov.timelock.canceller} /> = 國家 Safe</p>
            {gov.timelock.operations.length === 0 ? <p className="mt-2 text-sm text-zinc-500">沒有排程中的操作。</p> : (
              <table className="mt-2 w-full text-xs">
                <thead className="text-left text-zinc-500"><tr><th className="py-1">操作 id</th><th>目標</th><th>狀態</th><th>可執行時間</th></tr></thead>
                <tbody>{gov.timelock.operations.map((o) => (
                  <tr key={o.id} className="border-t border-zinc-200 dark:border-zinc-800"><td className="py-1 font-mono">{o.id.slice(0, 14)}…</td><td className="font-mono">{o.target.slice(0, 10)}… <span className="text-zinc-400">{o.data.slice(0, 10)}</span></td><td>{o.state}</td><td>{o.readyAt > 1 ? new Date(o.readyAt * 1000).toLocaleString("zh-TW") : "—"}</td></tr>
                ))}</tbody>
              </table>
            )}
          </Card>
        </div>
      ) : <p className="text-sm text-zinc-500">讀取中…</p>)}
    </div>
  );
}
