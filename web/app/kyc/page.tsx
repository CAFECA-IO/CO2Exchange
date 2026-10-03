"use client";
import { useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useAccount } from "@/components/AccountProvider";
import { AccountGate } from "@/components/AccountGate";
import { Button, Card, Field, Notice, inputCls } from "@/components/ui";
import { TIER, TIER_LABEL } from "@/lib/deployment";
import { postJson } from "@/lib/client/fetchJson";
import { WALLET, signInWithCafeca } from "@/lib/client/cafeca";

/// 身分驗證。
///
/// **本站的 KYC 就是 CAFECA 的實名**（CAFECA issue #1、#2）：自然人用證件＋活體驗證，法人用商工登記＋代表人比對
///（或工商憑證），都在 CAFECA 錢包裡完成。本站不再收身分證號——登入時使用者在錢包裡逐項同意提供
/// 證件姓名與同一人識別碼（法人是統編與公司名稱），伺服器驗過 CAFECA 簽的資料後，登記成帳本的身分。
///
/// 人工審核只留給 CAFECA 還不支援的主體（行號、有限合夥、財團／社團法人）。
const SIGNER_LABEL: Record<string, string> = { production: "正式簽章", prototype: "原型簽章（測試用）", none: "簽章者已失效" };
const DOC_LABEL: Record<string, string> = { national_id: "國民身分證", resident_permit: "居留證", passport: "護照" };

export default function KycPage() {
  // 身分從 AccountProvider 拿，不要自己再 fetch 一份。
  // 以前這頁自己存一份、provider 存另一份，兩邊各自決定何時刷新——
  // 管理員核准之後只有這頁重抓，於是這頁顯示「法人・有效」，
  // 同一時間 /trade 說「尚未完成身分驗證」、/enterprise 說「需要法人身分」。
  const { wallet, userId, identity, identityAt, refreshTier, refreshWallet } = useAccount();
  const [tier, setTier] = useState<number>(TIER.Corporate);
  const [idNumber, setIdNumber] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!userId || !wallet) return <AccountGate />;

  // 效期在「拿到資料的當下」判定（identityAt），render 期間不呼叫 Date.now()。
  const active = !!identity && identity.tier !== TIER.None && !identity.frozen && identity.expiry * 1000 > identityAt;
  const c = identity?.cafeca ?? null;
  const live = wallet.kyc ?? null;
  const manualIndividual = c?.manualIndividual ?? false;

  /// 重新以 CAFECA 登入，這一次同意提供實名資料。登入成功時伺服器就會登記帳本身分。
  async function shareWithCafeca() {
    setBusy("等待 CAFECA 錢包…"); setMsg(null);
    try {
      const response = await signInWithCafeca();
      const r = await signIn("cafeca", { response, redirect: false });
      if (r?.error) throw new Error("登入驗證沒有通過");
      refreshWallet(); refreshTier();
      setMsg({ kind: "ok", text: "已重新登入。若帳本身分還沒出現，下方會說明原因。" });
    } catch (e) { setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy("送出中…"); setMsg(null);
    try {
      const j = await postJson<{ status: string; txHash: string }>("/api/kyc", { account: wallet!.address, tier, idNumber, name });
      setMsg(j.status === "approved"
        ? { kind: "ok", text: `身分已綁定帳戶。交易 ${j.txHash.slice(0, 10)}…` }
        : { kind: "ok", text: "申請已送出，待身分驗證服務審核。" });
      refreshTier();
    } catch (e) { setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  }

  const fromCafeca = c?.record && (c.record.status === "approved" || c.record.status === "lapsed");

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="本站的身分">
          {identity ? (
            <dl className="space-y-1 text-sm">
              <div><dt className="text-ink-300">等級</dt><dd data-testid="kyc-tier">{TIER_LABEL[identity.tier]}</dd></div>
              <div><dt className="text-ink-300">來源</dt><dd>{fromCafeca ? "CAFECA 實名" : identity.application?.source === "manual" ? "人工審核" : identity.tier ? "—" : "尚未驗證"}</dd></div>
              <div><dt className="text-ink-300">有效期限</dt><dd>{identity.expiry ? new Date(identity.expiry * 1000).toLocaleDateString("zh-TW") : "—"}</dd></div>
              <div><dt className="text-ink-300">狀態</dt><dd data-testid="kyc-active">{identity.frozen ? "已凍結" : active ? "有效" : "未驗證 / 已失效"}</dd></div>
              <div><dt className="text-ink-300">身分雜湊</dt><dd className="font-mono text-xs break-all">{identity.identityHash}</dd></div>
              {identity.application && identity.application.source === "manual" && (
                <div><dt className="text-ink-300">人工審核申請</dt><dd data-testid="kyc-application">
                  {identity.application.status === "pending" ? "審核中" : identity.application.status === "approved" ? "已核准" : `已退回：${identity.application.reason || "—"}`}
                </dd></div>
              )}
            </dl>
          ) : <p className="text-sm text-ink-300">讀取中…</p>}
          {c?.record?.status === "lapsed" && (
            <div className="mt-3"><Notice kind="warn">CAFECA 的實名已失效：{c.record.reason}。持有不受影響，但交易會被擋下，直到你在 CAFECA 重新驗證。</Notice></div>
          )}
          {active && <div className="mt-4 flex gap-2"><Link href="/trade"><Button>前往交易</Button></Link>{identity?.tier === TIER.Corporate && <Link href="/enterprise"><Button variant="secondary">企業功能</Button></Link>}</div>}
          <div className="mt-3"><Button variant="secondary" onClick={() => { refreshTier(); refreshWallet(); }}>重新整理</Button></div>
        </Card>

        <Card title="以 CAFECA 實名驗證">
          <div className="space-y-3 text-sm leading-7 text-ink-200">
            <p>
              本站的身分驗證直接採用 CAFECA 的實名：<b>自然人</b>在 CAFECA 錢包完成證件與臉部驗證；
              <b>公司</b>在錢包建立公司帳戶、以統一編號通過商工登記驗證後，選擇「以公司身分」登入。
            </p>
            <p className="text-ink-300">
              登入時錢包會逐項詢問是否提供資料。本站需要：自然人的<b>證件姓名</b>（出金只能匯到同名帳戶）與<b>同一人識別碼</b>
              （確認一個人只有一個交易帳戶；每個網站拿到的值不同，推不回證號），公司的<b>統一編號</b>與<b>公司名稱</b>。
              本站不收身分證號。
            </p>
          </div>
          <dl className="mt-3 space-y-1 text-sm" data-testid="cafeca-status">
            <div><dt className="text-ink-300">CAFECA 實名</dt><dd>
              {live
                ? `${live.subjectType === "entity" ? "法人" : "自然人"} · L${live.effectiveLevel}${live.status !== "active" ? `（${{ none: "未驗證", suspended: "已暫停", revoked: "已撤銷" }[live.status] ?? live.status}）` : ""}`
                : wallet.kycLevel >= 2 ? `L${wallet.kycLevel}` : "未實名"}
            </dd></div>
            {live && live.effectiveLevel >= 2 && <div><dt className="text-ink-300">簽章</dt><dd>{SIGNER_LABEL[live.signerClass] ?? live.signerClass}</dd></div>}
            {live && live.expiry > 0 && <div><dt className="text-ink-300">CAFECA 效期</dt><dd>{new Date(live.expiry * 1000).toLocaleDateString("zh-TW")}</dd></div>}
            {c?.record?.docType && <div><dt className="text-ink-300">證件</dt><dd>{DOC_LABEL[c.record.docType] ?? c.record.docType}</dd></div>}
          </dl>
          {live?.signerClass === "prototype" && (
            <div className="mt-3"><Notice kind="warn">
              目前 CAFECA 的實名都是原型簽章。{c?.acceptPrototype ? "本站目前接受原型簽章（測試環境）；" : "本站正式環境只收正式簽章；"}
              CAFECA 換成正式簽章者時，原型期的實名會降為未實名，屆時需要在 CAFECA 重新驗證。
            </Notice></div>
          )}
          {c?.last && !c.last.adopted && (
            <div className="mt-3" data-testid="cafeca-reason"><Notice kind="warn">還沒有登記為本站身分：{c.last.reason}</Notice></div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={shareWithCafeca} disabled={!!busy}>{busy ?? (active && fromCafeca ? "重新登入以更新實名資料" : "以 CAFECA 實名驗證")}</Button>
            <a href={WALLET} target="_blank" rel="noreferrer"><Button variant="secondary">到 CAFECA 完成實名</Button></a>
          </div>
          {msg && <div className="mt-3"><Notice kind={msg.kind}>{msg.text}</Notice></div>}
        </Card>
      </div>

      <Card title="CAFECA 尚未支援的主體：人工審核">
        <p className="mb-3 text-xs leading-6 text-ink-300">
          CAFECA 目前只支援自然人與公司登記。商業登記（行號）、有限合夥、財團與社團法人請在這裡送件，由身分驗證服務人工審核。
          {manualIndividual && " 本機測試鏈也接受自然人送件（開發與自動測試用）。"}
          鏈上只存雜湊，證號在審核後即刪除。
        </p>
        <form className="space-y-3" onSubmit={submit}>
          <Field label="身分類型">
            <select className={inputCls} value={tier} onChange={(e) => setTier(Number(e.target.value))}>
              <option value={TIER.Corporate}>法人或其他組織（可購買、掛單、註銷）</option>
              {manualIndividual && <option value={TIER.Individual}>自然人（僅本機測試）</option>}
            </select>
          </Field>
          <Field label={tier === TIER.Individual ? "身分證字號" : "統一編號"}>
            <input className={inputCls} value={idNumber} onChange={(e) => setIdNumber(e.target.value)} placeholder={tier === TIER.Individual ? "A123456789" : "12345678"} required />
          </Field>
          <Field label="名稱（出金戶名要與它相同）">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="某某商行 / 某某基金會" />
          </Field>
          <Button type="submit" disabled={!!busy}>{busy === "送出中…" ? busy : "送出申請"}</Button>
        </form>
      </Card>
    </div>
  );
}
