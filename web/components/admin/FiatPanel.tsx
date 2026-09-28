"use client";
import { useEffect, useState } from "react";
import { useReload } from "@/lib/client/useReload";
import { Button, Card, Field, Notice, inputCls } from "@/components/ui";
import { fetchJson, postJson } from "@/lib/client/fetchJson";

/// 新台幣入出金的營運頁（規則第 4 版）。
///
/// 入金確認與出金確認都是**營運 Safe** 的鏈上交易。本機展示鏈上這一頁直接代送（持有人是公開的測試金鑰）；
/// 外部鏈上網站不持有營運 Safe 的金鑰，按下去只會得到要執行的內容與 `npm run fiat` 指令，
/// 由持有人在自己的機器上簽。退回出金請求是帳本裡的營運授權事件，門檻大於 1 時變成提案。

type Payout = { bankCode: string; accountNo: string; holder: string; payoutRef: string } | null;
type Row = {
  account: string; pending: string; settleable: string; waitingForCommit: string;
  requests: { seq: string; at: string; amount: string; payoutRef: string }[];
  payoutAccount: Payout; payoutMatches: boolean;
};
type Deposit = { id: string; account: string; amount: string; bankRef: string; txHash: string; by: string; createdAt?: string };
type Resp = {
  executesDirectly: boolean; operatorSafe: string; ledger: string; token: string;
  trust: { bank: string; branch: string; accountNo: string; accountName: string };
  withdrawals: Row[]; recentDeposits: Deposit[];
};
type Described = { executed: false; safe: string; to: string; data: string; cli: string };
type Result = { executed?: boolean; txHash?: string; mirrored?: number; safe?: string; to?: string; data?: string; cli?: string; appended?: unknown; proposal?: { id: string }; required?: number };

const yuan = (raw: string | bigint) => (Number(BigInt(raw)) / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 6 });
/// 元 → 最小單位字串。錯的格式回 null（不要默默變成 0）
function toUnits(s: string): string | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s.replace(/,/g, "").trim());
  if (!m) return null;
  const v = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return v > 0n ? v.toString() : null;
}
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;

export function FiatPanel() {
  const [r, setR] = useState<Resp | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [described, setDescribed] = useState<Described | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dep, setDep] = useState({ who: "", amount: "", bankRef: "" });
  const [out, setOut] = useState<Record<string, { amount: string; bankRef: string; reason: string }>>({});
  const [reloadKey, reload] = useReload();

  useEffect(() => {
    let ignore = false;
    fetchJson<Resp>("/api/admin/fiat")
      .then((j) => { if (!ignore) setR(j); })
      .catch((e) => { if (!ignore) setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) }); });
    return () => { ignore = true; };
  }, [reloadKey]);

  async function act(label: string, body: Record<string, string>) {
    setBusy(label); setMsg(null); setDescribed(null);
    try {
      const j = await postJson<Result>("/api/admin/fiat", body);
      if (j.executed === false) {
        setDescribed({ executed: false, safe: j.safe ?? "", to: j.to ?? "", data: j.data ?? "", cli: j.cli ?? "" });
        setMsg({ kind: "ok", text: `${label}：網站不持有營運 Safe 的金鑰，請持有人執行下方的內容` });
      } else if (j.executed) {
        setMsg({ kind: "ok", text: `${label}：已上鏈（${short(j.txHash ?? "")}），帳本鏡像 ${j.mirrored ?? 0} 筆` });
      } else if (j.proposal) {
        setMsg({ kind: "ok", text: `${label}：需要 ${j.required} 個營運簽章，已建立提案 ${j.proposal.id}（治理狀態頁）` });
      } else setMsg({ kind: "ok", text: `${label}：已寫進帳本` });
      reload();
    } catch (e) { setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  }

  if (!r) return <Card title="出入金"><p className="text-sm text-ink-300">{msg?.text ?? "讀取中…"}</p></Card>;
  const depUnits = toUnits(dep.amount);
  const t = r.trust;

  return (
    <div className="space-y-4" data-testid="fiat-panel">
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {described && (
        <Card title="交給營運 Safe 持有人執行">
          <p className="mb-2 text-xs text-ink-300">在持有人的機器上（金鑰在 repo 根目錄的 <code>.governance.env</code>，不在網站）：</p>
          <pre className="overflow-x-auto rounded bg-ink-800 p-3 text-xs"><code>{`cd web && ${described.cli}`}</code></pre>
          <p className="mt-3 mb-1 text-xs text-ink-300">或用硬體錢包走 Safe 簽章（<code>script/govern.sh</code>）：</p>
          <pre className="overflow-x-auto rounded bg-ink-800 p-3 text-xs"><code>{`safe ${described.safe}\nto   ${described.to}\ndata ${described.data}`}</code></pre>
        </Card>
      )}

      <Card title="入金確認" action={<span className="rounded bg-ink-600 px-2 py-0.5 text-xs text-ink-200">{r.executesDirectly ? "本機鏈：網站直接代送" : "外部鏈：產生指令"}</span>}>
        <p className="mb-3 text-xs text-ink-300">
          依信託專戶的對帳單確認一筆匯款：營運 Safe 呼叫 <code>creditDeposit</code>，帳本合約鑄出等額、只存在合約裡的記帳 TWD，
          帳本鏡像成這個帳戶的可動用新台幣。銀行交易參考號只以雜湊上鏈，同一個參考號合約不收第二次。
        </p>
        <p className="mb-3 text-xs">
          信託專戶：{t.bank}{t.branch ? ` ${t.branch}` : ""}　{t.accountNo || "（未設定帳號）"}　{t.accountName}
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="帳戶地址或入金識別碼"><input className={inputCls} value={dep.who} onChange={(e) => setDep({ ...dep, who: e.target.value })} placeholder="0x… 或 10 位數字" data-testid="fiat-dep-who" /></Field>
          <Field label="金額（元）"><input className={inputCls} value={dep.amount} onChange={(e) => setDep({ ...dep, amount: e.target.value })} inputMode="decimal" data-testid="fiat-dep-amount" /></Field>
          <Field label="銀行交易參考號"><input className={inputCls} value={dep.bankRef} onChange={(e) => setDep({ ...dep, bankRef: e.target.value })} placeholder="對帳單上的那一筆" data-testid="fiat-dep-ref" /></Field>
        </div>
        <div className="mt-3">
          <Button disabled={!!busy || !dep.who.trim() || !depUnits || !dep.bankRef.trim()} data-testid="fiat-dep-submit"
            onClick={() => { if (depUnits && confirm(`確認入金 ${yuan(depUnits)} 元給 ${dep.who.trim()}？\n這是營運 Safe 的鏈上交易，確認後不能撤回。`)) act("確認入金", { op: "deposit", who: dep.who.trim(), amount: depUnits, bankRef: dep.bankRef.trim() }); }}>
            確認入金
          </Button>
        </div>
        {r.recentDeposits.length > 0 && (
          <table className="mt-4 w-full text-xs">
            <thead className="text-left text-ink-300"><tr><th className="py-1">帳戶</th><th className="pr-6 text-right">金額（元）</th><th className="pr-4">bankRef</th><th>交易</th></tr></thead>
            <tbody>{r.recentDeposits.map((d) => (
              <tr key={d.id} className="border-t border-ink-500"><td className="py-1 font-mono">{short(d.account)}</td><td className="pr-6 text-right">{yuan(d.amount)}</td><td className="pr-4 font-mono">{d.bankRef.slice(0, 10)}…</td><td className="font-mono">{short(d.txHash)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>

      <Card title="待出金">
        <p className="mb-3 text-xs text-ink-300">
          使用者簽的出金請求帶收款帳戶的雜湊。請求要先進一期承諾（最長一小時）才能確認；確認前先依下面的收款帳戶匯款，
          再填匯款的交易參考號按「已匯款，確認出金」——營運 Safe 憑最新一期的證據呼叫 <code>settleWithdrawal</code>，銷毀等額的記帳 TWD。
          不匯款就「退回」，金額回到使用者的可動用新台幣。
        </p>
        {r.withdrawals.length === 0 && <p className="text-sm text-ink-300">沒有待出金。</p>}
        <div className="space-y-3">
          {r.withdrawals.map((w) => {
            const f = out[w.account] ?? { amount: yuan(BigInt(w.settleable) > 0n ? w.settleable : w.pending).replace(/,/g, ""), bankRef: "", reason: "" };
            const set = (p: Partial<typeof f>) => setOut({ ...out, [w.account]: { ...f, ...p } });
            const units = toUnits(f.amount);
            return (
              <div key={w.account} className="rounded border border-ink-500 p-3 text-sm" data-testid="fiat-withdrawal">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-xs">{w.account}</span>
                  <span>待出金 <b>{yuan(w.pending)}</b> 元　可確認 <b>{yuan(w.settleable)}</b> 元{BigInt(w.waitingForCommit) > 0n && <span className="text-ink-300">　等下一期 {yuan(w.waitingForCommit)} 元</span>}</span>
                </div>
                <div className="mt-2 text-xs">
                  {w.payoutAccount
                    ? <>收款帳戶：銀行代碼 {w.payoutAccount.bankCode}　帳號 <span className="font-mono">{w.payoutAccount.accountNo}</span>　戶名 {w.payoutAccount.holder}</>
                    : <span className="text-warn">⚠ 找不到收款帳戶的明文</span>}
                  {w.payoutAccount && !w.payoutMatches && <div className="mt-1 text-warn">⚠ 出金請求裡的收款帳戶雜湊與目前設定的不同（使用者簽署後改過收款帳戶）：請退回，請使用者重新申請</div>}
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-[10rem_1fr_auto]">
                  <input className={inputCls} value={f.amount} onChange={(e) => set({ amount: e.target.value })} inputMode="decimal" placeholder="金額（元）" aria-label="金額（元）" />
                  <input className={inputCls} value={f.bankRef} onChange={(e) => set({ bankRef: e.target.value })} placeholder="匯款交易參考號" aria-label="匯款交易參考號" />
                  <Button className="whitespace-nowrap" disabled={!!busy || !units || !f.bankRef.trim() || BigInt(w.settleable) === 0n || !w.payoutMatches}
                    onClick={() => { if (units && confirm(`已匯出 ${yuan(units)} 元到 ${w.payoutAccount?.bankCode ?? "?"}-${w.payoutAccount?.accountNo ?? "?"}？\n確認出金是營運 Safe 的鏈上交易，不能撤回。`)) act("確認出金", { op: "settle", account: w.account, amount: units, bankRef: f.bankRef.trim() }); }}>
                    已匯款，確認出金
                  </Button>
                  <span className="hidden md:block" />
                  <input className={inputCls} value={f.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="退回原因（使用者看得到）" aria-label="退回原因" />
                  <Button variant="secondary" className="whitespace-nowrap" disabled={!!busy || !units}
                    onClick={() => { if (units && confirm(`退回 ${yuan(units)} 元的出金請求？金額回到使用者的可動用新台幣。`)) act("退回出金", { op: "reject", account: w.account, amount: units, reason: f.reason.trim() || "退回" }); }}>
                    退回請求
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <p className="text-xs text-ink-300">
        營運 Safe <span className="font-mono">{short(r.operatorSafe)}</span>　帳本合約 <span className="font-mono">{short(r.ledger)}</span>　記帳 TWD <span className="font-mono">{short(r.token)}</span>
        （不能轉出；總量＝營運方宣稱的信託專戶餘額）
      </p>
    </div>
  );
}
