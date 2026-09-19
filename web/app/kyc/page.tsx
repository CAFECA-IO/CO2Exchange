"use client";
import { useCallback, useEffect, useState } from "react";
import { useAccount } from "@/components/AccountProvider";
import { Button, Card, Field, Notice, inputCls } from "@/components/ui";
import { TIER, TIER_LABEL } from "@/lib/deployment";
import Link from "next/link";

type Identity = { tier: number; expiry: number; frozen: boolean; jurisdiction: string; identityHash: string };

export default function KycPage() {
  const { credential, userId } = useAccount();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [tier, setTier] = useState<number>(TIER.Individual);
  const [idNumber, setIdNumber] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!credential) return;
    const r = await fetch(`/api/kyc?account=${credential.address}`);
    if (r.ok) setIdentity(await r.json());
  }, [credential]);
  useEffect(() => { refresh(); }, [refresh]);

  if (!userId) return <Notice>請先在<Link className="underline" href="/">首頁</Link>登入。</Notice>;
  if (!credential) return <Notice>請先在<Link className="underline" href="/">首頁</Link>建立鏈上帳戶。</Notice>;

  const active = identity && identity.tier !== TIER.None && !identity.frozen && identity.expiry * 1000 > Date.now();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/kyc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: credential!.address, tier, idNumber, name }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "失敗");
      setMsg({ kind: "ok", text: `身分已綁定帳戶。交易 ${j.txHash.slice(0, 10)}…` });
      await refresh();
    } catch (e) { setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card title="身分狀態">
        {identity ? (
          <dl className="space-y-1 text-sm">
            <div><dt className="text-zinc-500">等級</dt><dd>{TIER_LABEL[identity.tier]}</dd></div>
            <div><dt className="text-zinc-500">有效期限</dt><dd>{identity.expiry ? new Date(identity.expiry * 1000).toLocaleDateString("zh-TW") : "—"}</dd></div>
            <div><dt className="text-zinc-500">狀態</dt><dd>{identity.frozen ? "已凍結" : active ? "有效" : "未驗證 / 已到期"}</dd></div>
            <div><dt className="text-zinc-500">身分雜湊</dt><dd className="font-mono text-xs break-all">{identity.identityHash}</dd></div>
          </dl>
        ) : <p className="text-sm text-zinc-500">讀取中…</p>}
        {active && <div className="mt-4"><Link href="/trade"><Button>前往購買與註銷</Button></Link></div>}
      </Card>

      <Card title="以政府憑證驗證身分">
        <p className="mb-3 text-xs text-zinc-500">
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
