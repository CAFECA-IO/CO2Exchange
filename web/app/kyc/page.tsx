"use client";
import { useState } from "react";
import { useAccount } from "@/components/AccountProvider";
import { AccountGate } from "@/components/AccountGate";
import { Button, Card, Field, Notice, inputCls } from "@/components/ui";
import { TIER, TIER_LABEL } from "@/lib/deployment";
import Link from "next/link";
import { postJson } from "@/lib/client/fetchJson";

export default function KycPage() {
  // 身分從 AccountProvider 拿，不要自己再 fetch 一份。
  // 以前這頁自己存一份、provider 存另一份，兩邊各自決定何時刷新——
  // 管理員核准之後只有這頁重抓，於是這頁顯示「法人・有效」，
  // 同一時間 /trade 說「尚未完成身分驗證」、/enterprise 說「需要法人身分」。
  // 而那顆能同步兩邊的「重新整理」按鈕只在審核中才出現，核准後就不見了，
  // 使用者除了整頁重新載入之外沒有任何辦法。
  const { credential, userId, identity, identityAt, refreshTier } = useAccount();
  const [tier, setTier] = useState<number>(TIER.Individual);
  const [idNumber, setIdNumber] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!userId || !credential) return <AccountGate />;

  // 效期在「拿到資料的當下」判定（identityAt），render 期間不呼叫 Date.now()——
  // 那是不純的讀取，同一份資料在不同 render 會得到不同結果。
  const active = !!identity && identity.tier !== TIER.None && !identity.frozen && identity.expiry * 1000 > identityAt;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const j = await postJson<{ status: string; txHash: string }>("/api/kyc", { account: credential!.address, tier, idNumber, name });
      setMsg(j.status === "approved"
        ? { kind: "ok", text: `身分已綁定帳戶。交易 ${j.txHash.slice(0, 10)}…` }
        : { kind: "ok", text: "申請已送出，待身分驗證服務審核。" });
      await refreshTier();
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
        {active && <div className="mt-4 flex gap-2"><Link href="/trade"><Button>前往交易</Button></Link>{identity?.tier === TIER.Corporate && <Link href="/enterprise"><Button variant="secondary">企業功能</Button></Link>}</div>}
        {/* 核准是管理員在別的地方做的，這一頁不會自己知道，所以重新整理一直要能按，
            不是只在「審核中」才出現——核准之後那顆按鈕消失，才是真的沒辦法。 */}
        <div className="mt-3"><Button variant="secondary" onClick={refreshTier}>重新整理</Button></div>
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
