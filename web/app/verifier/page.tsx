"use client";
import { useCallback, useEffect, useState } from "react";
import { useAccount } from "@/components/AccountProvider";
import { Button, Card, Notice, fmtKg } from "@/components/ui";

type Issuance = { id: string; projectId: number; projectName: string; owner: string; submittedBy: string; monitoringStart: string; monitoringEnd: string; amountKg: number; reportName: string; reportHash: string; reportFile: string; note?: string; status: string; reason?: string; batchId?: number; txHash?: string; createdAt: string; decidedBy?: string };

export default function VerifierPage() {
  const { me } = useAccount();
  const [rows, setRows] = useState<Issuance[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const r = await fetch("/api/issuance"); if (r.ok) setRows((await r.json()).requests ?? []);
  }, []);
  useEffect(() => { if (me.isVerifier) refresh(); }, [me.isVerifier, refresh]);

  if (!me.isVerifier) return <Notice>此頁面限查驗機構帳號。</Notice>;

  async function decide(id: string, approve: boolean) {
    setBusy(id); setMsg(null);
    try {
      const r = await fetch(`/api/issuance/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve, reason: reason[id] ?? "" }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "失敗");
      setMsg({ kind: "ok", text: approve ? `已簽章核發：批次 #${j.batchId}，tx ${j.txHash.slice(0, 10)}…` : "已退回" });
      await refresh();
    } catch (e) { setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  }

  const pending = rows.filter((r) => r.status === "pending");
  const done = rows.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-6">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        核發 = 以查驗機構金鑰簽署 IssuanceAttestation（專案、監測期間、噸數、報告雜湊）並送上鏈；額度直接發到專案擁有者帳戶。序號由登錄簿保證唯一。
      </p>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <Card title={`待查驗（${pending.length}）`}>
        {pending.length === 0 ? <p className="text-sm text-zinc-500">目前沒有待審申請。</p> : (
          <ul className="space-y-3 text-sm">
            {pending.map((r) => (
              <li key={r.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800" data-testid="verifier-row">
                <div className="font-medium">#{r.projectId} {r.projectName} · {fmtKg(r.amountKg)} · {r.monitoringStart} ~ {r.monitoringEnd}</div>
                <div className="mt-1 text-xs text-zinc-500">申請人 {r.submittedBy} · 帳戶 <span className="font-mono">{r.owner}</span> · {new Date(r.createdAt).toLocaleString("zh-TW")}</div>
                <div className="mt-1 text-xs">報告 <a className="underline" href={`/api/uploads/${r.reportFile}`} target="_blank">{r.reportName}</a> · SHA-256 <span className="font-mono break-all">{r.reportHash}</span></div>
                {r.note && <div className="mt-1 text-xs">備註：{r.note}</div>}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button onClick={() => decide(r.id, true)} disabled={busy === r.id}>{busy === r.id ? "簽章中…" : "簽章並核發"}</Button>
                  <input className="w-56 rounded-lg border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950" placeholder="退回原因" value={reason[r.id] ?? ""} onChange={(e) => setReason({ ...reason, [r.id]: e.target.value })} />
                  <Button variant="secondary" onClick={() => decide(r.id, false)} disabled={busy === r.id}>退回</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="已處理">
        {done.length === 0 ? <p className="text-sm text-zinc-500">—</p> : (
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500"><tr><th className="py-1">專案</th><th>期間</th><th>噸數</th><th>結果</th><th>處理者</th></tr></thead>
            <tbody>{done.map((r) => (
              <tr key={r.id} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className="py-1">#{r.projectId} {r.projectName}</td><td>{r.monitoringStart} ~ {r.monitoringEnd}</td><td>{fmtKg(r.amountKg)}</td>
                <td>{r.status === "issued" ? `已核發 批次 #${r.batchId}` : `退回：${r.reason || "—"}`}</td><td className="text-xs">{r.decidedBy}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
