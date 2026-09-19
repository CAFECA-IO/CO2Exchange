"use client";
import { useEffect, useState } from "react";
import { useReload } from "@/lib/client/useReload";
import { useAccount } from "@/components/AccountProvider";
import { AccountGate } from "@/components/AccountGate";
import { Button, Card, Field, Notice, inputCls } from "@/components/ui";
import { TIER, TIER_LABEL } from "@/lib/deployment";
import Link from "next/link";

type Identity = { tier: number; expiry: number; frozen: boolean; jurisdiction: string; identityHash: string; application: { id: string; status: string; tier: number; reason?: string; createdAt: string } | null };

export default function KycPage() {
  const { credential, userId, refreshTier } = useAccount();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [tier, setTier] = useState<number>(TIER.Individual);
  const [idNumber, setIdNumber] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 效期是否過了，在「拿到資料的當下」判定並記下來；render 期間不呼叫 Date.now()
  // （那是不純的讀取，會讓同一份資料在不同 render 得到不同結果）。
  const [checkedAt, setCheckedAt] = useState(0);
  const [reloadKey, reload] = useReload();
  useEffect(() => {
    if (!credential) return;
    let ignore = false;
    (async () => {
      const r = await fetch(`/api/kyc?account=${credential.address}`);
      if (ignore || !r.ok) return;
      setIdentity(await r.json());
      setCheckedAt(Date.now());
    })();
    return () => { ignore = true; };
  }, [credential, reloadKey]);

  if (!userId || !credential) return <AccountGate />;

  const active = !!identity && identity.tier !== TIER.None && !identity.frozen && identity.expiry * 1000 > checkedAt;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/kyc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: credential!.address, tier, idNumber, name }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "失敗");
      setMsg(j.status === "approved"
        ? { kind: "ok", text: `身分已綁定帳戶。交易 ${j.txHash.slice(0, 10)}…` }
        : { kind: "ok", text: "申請已送出，待身分驗證服務審核。" });
      reload(); await refreshTier();
    } catch (e) { setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card title="身分狀態">
        {identity ? (
          <dl className="space-y-1 text-sm">
            <div><dt className="text-ink-300">等級</dt><dd>{TIER_LABEL[identity.tier]}</dd></div>
            <div><dt className="text-ink-300">有效期限</dt><dd>{identity.expiry ? new Date(identity.expiry * 1000).toLocaleDateString("zh-TW") : "—"}</dd></div>
            <div><dt className="text-ink-300">狀態</dt><dd>{identity.frozen ? "已凍結" : active ? "有效" : "未驗證 / 已到期"}</dd></div>
            <div><dt className="text-ink-300">身分雜湊</dt><dd className="font-mono text-xs break-all">{identity.identityHash}</dd></div>
            {identity.application && (
              <div><dt className="text-ink-300">最近申請</dt><dd data-testid="kyc-application">
                {identity.application.status === "pending" ? "審核中" : identity.application.status === "approved" ? "已核准" : `已退回：${identity.application.reason || "—"}`}
              </dd></div>
            )}
          </dl>
        ) : <p className="text-sm text-ink-300">讀取中…</p>}
        {active && <div className="mt-4 flex gap-2"><Link href="/trade"><Button>前往購買與註銷</Button></Link>{identity?.tier === TIER.Corporate && <Link href="/enterprise"><Button variant="secondary">企業功能</Button></Link>}</div>}
        {identity?.application?.status === "pending" && <div className="mt-3"><Button variant="secondary" onClick={() => { reload(); refreshTier(); }}>重新整理</Button></div>}
      </Card>

      <Card title="以政府憑證驗證身分">
        <p className="mb-3 text-xs text-ink-300">
          正式環境：此步驟以工商憑證（法人）或自然人憑證 / TW FidO（個人）對帳戶地址簽章，由身分驗證服務驗證憑證鏈後簽發 attestation。
          Phase 0 只檢查格式並模擬簽發。鏈上只存雜湊，不存個資。
        </p>
        <form className="space-y-3" onSubmit={submit}>
          <Field label="身分類型">
            <select className={inputCls} value={tier} onChange={(e) => setTier(Number(e.target.value))}>
              <option value={TIER.Individual}>自然人（可購買、註銷；不可轉售）</option>
              <option value={TIER.Corporate}>法人（可購買、掛單、註銷）</option>
            </select>
          </Field>
          <Field label={tier === TIER.Individual ? "身分證字號" : "統一編號"}>
            <input className={inputCls} value={idNumber} onChange={(e) => setIdNumber(e.target.value)} placeholder={tier === TIER.Individual ? "A123456789" : "12345678"} required />
          </Field>
          <Field label="顯示名稱（僅存於憑證受益人欄位）">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="王小明 / 某某股份有限公司" />
          </Field>
          <Button type="submit" disabled={busy}>{busy ? "簽發中…" : "驗證並綁定帳戶"}</Button>
        </form>
        {msg && <div className="mt-3"><Notice kind={msg.kind}>{msg.text}</Notice></div>}
      </Card>
    </div>
  );
}
