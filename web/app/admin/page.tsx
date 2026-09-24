"use client";
import { useEffect, useState } from "react";
import { useReload } from "@/lib/client/useReload";
import { useAccount } from "@/components/AccountProvider";
import { Button, Card, Field, Notice, fmtKg, inputCls } from "@/components/ui";
import { PURPOSE_LABEL, TIER_LABEL, flagOf } from "@/lib/deployment";
import { fetchJson, postJson } from "@/lib/client/fetchJson";

type KycReq = { id: string; account: string; tier: number; idNumberMasked: string; name: string; email: string; status: string; reason?: string; txHash?: string; createdAt: string; decidedBy?: string };
type Cert = { certId: number; batchId: number; amountKg: number; beneficiary: string; purpose: number; retiredAt: number; owner: string; pdfHash: string | null; onchainHash: string | null; anchored: boolean };
type Gov = {
  matrix: { name: string; address: string; admin: boolean; sovereign: boolean | null; operator: boolean | null }[];
  hasV4: boolean;
  poolManagerOwner: string | null; poolManagerOwnerIsTimelock: boolean; listingPaused: boolean; poolPaused: boolean; trustedRouter: string | null; swapsEnabled: boolean;
  nationalSafe: { address: string; owners: string[]; threshold: number }; operatorSafe: { address: string; owners: string[]; threshold: number };
  timelock: { address: string; delay: number; proposer: boolean; executor: boolean; canceller: boolean; operations: { id: string; target: string; data: string; state: string; readyAt: number; txHash: string }[] };
};

const tabs = ["KYC 審核", "憑證文件", "費率設定", "治理狀態"] as const;

/// 定義在元件內部的話，每次 render 都是一個新的元件型別，React 會把整棵子樹卸載重建。
function Bool({ v }: { v: boolean | null }) {
  return v === null
    ? <span className="text-ink-300">—</span>
    : <span className={v ? "text-tide" : "font-semibold text-down"}>{v ? "✓" : "✗"}</span>;
}

type Fees = {
  enabled: boolean;
  defaultTradeBps: number;
  defaultRetireFeePerTonne: string;
  rows: { country: string; name: string; scheme: string; enabled: boolean; domestic: boolean; custom: boolean; tradeBps: number; retireFeePerTonne: string }[];
};

export default function AdminPage() {
  const { me } = useAccount();
  const [tab, setTab] = useState<(typeof tabs)[number]>("KYC 審核");
  const [kyc, setKyc] = useState<KycReq[]>([]);
  const [certs, setCerts] = useState<Cert[]>([]);
  const [gov, setGov] = useState<Gov | null>(null);
  const [fees, setFees] = useState<Fees | null>(null);
  /// 編輯中的費率（尚未送出）。key 為國別代碼，"__default" 為預設值。
  const [draft, setDraft] = useState<Record<string, { tradeBps: string; retire: string }>>({});
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});

  const [reloadKey, reload] = useReload();
  useEffect(() => {
    if (!me.isAdmin) return;
    let ignore = false;
    (async () => {
      // 四個區塊互相獨立：其中一個讀不到不該把整頁弄空，所以各自 catch。
      const [k, c, g, f] = await Promise.all([
        fetchJson<{ requests: KycReq[] }>("/api/kyc/queue").catch(() => null),
        fetchJson<{ certificates: Cert[] }>("/api/certificates/all").catch(() => null),
        fetchJson<Gov>("/api/governance").catch(() => null),
        fetchJson<Fees>("/api/fees").catch(() => null),
      ]);
      if (ignore) return;
      if (k) setKyc(k.requests ?? []);
      if (c) setCerts(c.certificates ?? []);
      if (g) setGov(g);
      if (f) setFees(f);
    })();
    return () => { ignore = true; };
  }, [me.isAdmin, reloadKey]);

  if (!me.isAdmin) return <Notice>此頁面限管理員帳號。</Notice>;

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label); setMsg(null);
    try {
      const j = (await fn()) as { txHash?: string; sha256?: string };
      setMsg({ kind: "ok", text: `${label}完成${j.txHash ? ` · tx ${j.txHash.slice(0, 10)}…` : ""}${j.sha256 ? ` · SHA-256 ${j.sha256.slice(0, 14)}…` : ""}` });
      reload();
    } catch (e) { setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  }
  const post = (url: string, body?: unknown) => postJson<unknown>(url, body ?? {});

  const pendingKyc = kyc.filter((r) => r.status === "pending");

  return (
    <div className="space-y-4">
      <div className="flex gap-2">{tabs.map((t) => <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-sm ${tab === t ? "bg-tide text-white" : "border border-ink-500"}`}>{t}</button>)}</div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      {tab === "KYC 審核" && (
        <Card title={`待審核（${pendingKyc.length}）`}>
          <p className="mb-3 text-xs text-ink-300">核准 = 身分驗證服務簽發 attestation 並上鏈。正式環境此處為憑證鏈驗證結果，不是人工按鈕。</p>
          {pendingKyc.length === 0 ? <p className="text-sm text-ink-300">沒有待審申請。</p> : (
            <ul className="space-y-2 text-sm">
              {pendingKyc.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-500 p-3" data-testid="kyc-row">
                  <div className="flex-1">
                    <div>{TIER_LABEL[r.tier]} · {r.name || "—"} · {r.idNumberMasked} · {r.email}</div>
                    <div className="font-mono text-xs text-ink-300">{r.account}</div>
                  </div>
                  <Button onClick={() => act("核准", () => post("/api/kyc/decide", { id: r.id, approve: true }))} disabled={!!busy}>核准</Button>
                  <input className="w-40 rounded-lg border border-ink-500 px-2 py-1 text-xs" placeholder="退回原因" value={reason[r.id] ?? ""} onChange={(e) => setReason({ ...reason, [r.id]: e.target.value })} />
                  <Button variant="secondary" onClick={() => act("退回", () => post("/api/kyc/decide", { id: r.id, approve: false, reason: reason[r.id] ?? "" }))} disabled={!!busy}>退回</Button>
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-5 mb-2 text-sm font-semibold">歷史</h3>
          <table className="w-full text-xs">
            <thead className="text-left text-ink-300"><tr><th className="py-1">時間</th><th>帳戶</th><th>類型</th><th>結果</th><th>處理者</th></tr></thead>
            <tbody>{kyc.filter((r) => r.status !== "pending").map((r) => (
              <tr key={r.id} className="border-t border-ink-500"><td className="py-1">{new Date(r.createdAt).toLocaleString("zh-TW")}</td><td className="font-mono">{r.account.slice(0, 10)}…</td><td>{TIER_LABEL[r.tier]}</td><td>{r.status === "approved" ? "核准" : `退回：${r.reason || "—"}`}</td><td>{r.decidedBy}</td></tr>
            ))}</tbody>
          </table>
        </Card>
      )}

      {tab === "憑證文件" && (
        <Card title="註銷憑證 PDF 與鏈上雜湊回寫">
          <p className="mb-3 text-xs text-ink-300">流程：產生 PDF → 檔案 SHA-256 → 以 DOCUMENT_ROLE 金鑰回寫 <code>documentHash</code>。回寫後不可重新產生。</p>
          {certs.length === 0 ? <p className="text-sm text-ink-300">尚無憑證。</p> : (
            <table className="w-full text-sm">
              <thead className="text-left text-ink-300"><tr><th className="py-1">#</th><th>受益人</th><th>數量</th><th>用途</th><th>PDF</th><th>鏈上</th><th></th></tr></thead>
              <tbody>{certs.map((c) => (
                <tr key={c.certId} className="border-t border-ink-500" data-testid="cert-row">
                  <td className="py-2">{c.certId}</td><td>{c.beneficiary || "—"}</td><td>{fmtKg(c.amountKg)}</td><td>{PURPOSE_LABEL[c.purpose]}</td>
                  <td className="font-mono text-xs">{c.pdfHash ? <a className="underline" href={`/api/certificates/${c.certId}/pdf`} target="_blank">{c.pdfHash.slice(0, 12)}…</a> : "—"}</td>
                  <td className="font-mono text-xs">{c.onchainHash ? `${c.onchainHash.slice(0, 12)}…` : "—"} {c.anchored && <span className="text-tide">✓</span>}</td>
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


      {tab === "費率設定" && (
        <Card title="各國交易與註銷手續費">
          <p className="mb-3 text-xs leading-6 text-ink-300">
            交易手續費按成交金額的比例（bps，上限 500 = 5%）收取，由賣方承擔；
            註銷手續費按<b>每公噸固定金額</b>收取，向憑證收件人收取。
            兩者單位不同是刻意的：註銷是代辦一次官方移轉與註銷申請，成本按件與按量算，跟當天市價無關。
            沒有勾「專屬費率」的轄區走預設值。
          </p>
          {!fees?.enabled ? <p className="text-sm text-ink-300">這個部署沒有費率表合約。</p> : (
            <>
              <div className="mb-4 flex flex-wrap items-end gap-3 rounded-[--radius-card] border border-ink-500 bg-ink-800 p-3">
                <div className="text-sm font-medium text-ink-50">預設費率</div>
                <Field label="交易（bps）">
                  <input className={`${inputCls} w-24`} type="number" min="0" max="500"
                    value={draft.__default?.tradeBps ?? String(fees.defaultTradeBps)}
                    onChange={(e) => setDraft({ ...draft, __default: { tradeBps: e.target.value, retire: draft.__default?.retire ?? String(Number(fees.defaultRetireFeePerTonne) / 1e6) } })} />
                </Field>
                <Field label="註銷（mTWD / 噸）">
                  <input className={`${inputCls} w-28`} type="number" min="0" step="0.01"
                    value={draft.__default?.retire ?? String(Number(fees.defaultRetireFeePerTonne) / 1e6)}
                    onChange={(e) => setDraft({ ...draft, __default: { tradeBps: draft.__default?.tradeBps ?? String(fees.defaultTradeBps), retire: e.target.value } })} />
                </Field>
                <Button
                  onClick={() => act("更新預設費率", () => post("/api/fees", {
                    defaults: true,
                    tradeBps: Number(draft.__default?.tradeBps ?? fees.defaultTradeBps),
                    retireFeePerTonne: Number(draft.__default?.retire ?? Number(fees.defaultRetireFeePerTonne) / 1e6),
                  }))}
                  disabled={!!busy}
                >儲存</Button>
              </div>

              <table className="w-full text-sm">
                <thead className="text-left text-ink-300">
                  <tr>
                    <th className="py-1">轄區</th><th>機制</th><th>狀態</th>
                    <th>交易（bps）</th><th>註銷（mTWD / 噸）</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {fees.rows.map((r) => {
                    const dft = draft[r.country] ?? { tradeBps: String(r.tradeBps), retire: String(Number(r.retireFeePerTonne) / 1e6) };
                    const set = (patch: Partial<typeof dft>) => setDraft({ ...draft, [r.country]: { ...dft, ...patch } });
                    return (
                      <tr key={r.country} className="border-t border-ink-500" data-testid="fee-row">
                        <td className="py-2 whitespace-nowrap">{flagOf(r.country)} {r.country}　{r.name}</td>
                        <td>{r.scheme}</td>
                        <td className={r.enabled ? "text-ink-200" : "text-warn"}>
                          {r.enabled ? (r.domestic ? "國內" : "開放") : "暫不開放"}
                          {r.custom && <span className="ml-1 text-xs text-tide">專屬</span>}
                        </td>
                        <td><input className={`${inputCls} w-20`} type="number" min="0" max="500" value={dft.tradeBps} onChange={(e) => set({ tradeBps: e.target.value })} /></td>
                        <td><input className={`${inputCls} w-24`} type="number" min="0" step="0.01" value={dft.retire} onChange={(e) => set({ retire: e.target.value })} /></td>
                        <td className="whitespace-nowrap text-right">
                          <Button variant="secondary" onClick={() => act(`設定 ${r.country} 費率`, () => post("/api/fees", {
                            country: r.country, custom: true, tradeBps: Number(dft.tradeBps), retireFeePerTonne: Number(dft.retire),
                          }))} disabled={!!busy}>設為專屬</Button>
                          {r.custom && (
                            <span className="ml-2">
                              <Button variant="ghost" onClick={() => act(`${r.country} 回到預設`, () => post("/api/fees", {
                                country: r.country, custom: false, tradeBps: 0, retireFeePerTonne: 0,
                              }))} disabled={!!busy}>回到預設</Button>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-3 text-xs leading-6 text-ink-300">
                費率變更由 PRICING_ROLE 的服務金鑰送交易上鏈，立刻生效並可在鏈上追溯。
                治理角色（OPERATOR）在營運 Safe 手上，服務金鑰隨時可被撤銷。
              </p>
            </>
          )}
        </Card>
      )}

      {tab === "治理狀態" && (gov ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="角色矩陣" className="md:col-span-2">
            <table className="w-full text-sm">
              <thead className="text-left text-ink-300"><tr><th className="py-1">合約</th><th>admin = Timelock</th><th>sovereign = 國家 Safe</th><th>operator = 營運 Safe</th></tr></thead>
              <tbody>{gov.matrix.map((m) => (
                <tr key={m.name} className="border-t border-ink-500"><td className="py-1">{m.name} <span className="font-mono text-xs text-ink-300">{m.address.slice(0, 8)}…</span></td><td><Bool v={m.admin} /></td><td><Bool v={m.sovereign} /></td><td><Bool v={m.operator} /></td></tr>
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
            {gov.timelock.operations.length === 0 ? <p className="mt-2 text-sm text-ink-300">沒有排程中的操作。</p> : (
              <table className="mt-2 w-full text-xs">
                <thead className="text-left text-ink-300"><tr><th className="py-1">操作 id</th><th>目標</th><th>狀態</th><th>可執行時間</th></tr></thead>
                <tbody>{gov.timelock.operations.map((o) => (
                  <tr key={o.id} className="border-t border-ink-500"><td className="py-1 font-mono">{o.id.slice(0, 14)}…</td><td className="font-mono">{o.target.slice(0, 10)}… <span className="text-ink-300">{o.data.slice(0, 10)}</span></td><td>{o.state}</td><td>{o.readyAt > 1 ? new Date(o.readyAt * 1000).toLocaleString("zh-TW") : "—"}</td></tr>
                ))}</tbody>
              </table>
            )}
          </Card>
        </div>
      ) : <p className="text-sm text-ink-300">讀取中…</p>)}
    </div>
  );
}
