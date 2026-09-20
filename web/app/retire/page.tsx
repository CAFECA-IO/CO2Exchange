"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { encodeFunctionData, keccak256, toBytes, type Hex } from "viem";
import { useAccount } from "@/components/AccountProvider";
import { AccountGate } from "@/components/AccountGate";
import { AgreementCheck, useAgreementGate } from "@/components/AgreementGate";
import { Button, Card, Field, Notice, fmtKg, inputCls } from "@/components/ui";
import { creditAbi, poolAbi } from "@/lib/abis";
import { PURPOSE_LABEL } from "@/lib/deployment";
import { signAndRelay, type Call } from "@/lib/client/passkey";
import { useReload } from "@/lib/client/useReload";

/// 註銷並取得憑證。
///
/// 為什麼跟交易分開：註銷是「把額度用掉」，跟買賣是完全不同的動作，而且不可逆、
/// 自然人根本不能做。混在下單頁裡，使用者會以為買完就要按一下註銷。
///
/// 這一頁只做一件事：選批次、填受益人與用途、確認、簽章。確認單擋在前面，
/// 因為註銷之後沒有回頭路。

type Market = {
  holdings: { twd: string; cct: string; batches: { batchId: number; kg: number; vintageYear: number; project: string }[] } | null;
};

/// 主管機關於註銷次日起五個工作日內公開；公開後才可以對外宣告。
function announceableFrom(from = new Date()) {
  const d = new Date(from);
  let left = 5;
  d.setDate(d.getDate() + 1);
  while (left > 0) {
    const w = d.getDay();
    if (w !== 0 && w !== 6) left -= 1;
    if (left > 0) d.setDate(d.getDate() + 1);
  }
  return d.toLocaleDateString("zh-TW");
}

export default function RetirePage() {
  const { credential, config, userId, tier } = useAccount();
  const [m, setM] = useState<Market | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [beneficiary, setBeneficiary] = useState("");
  const [purpose, setPurpose] = useState(1);
  const [memo, setMemo] = useState("");
  /// 選定要註銷的標的："b<batchId>" 或 "cct"
  const [target, setTarget] = useState<string | null>(null);
  const [tonnes, setTonnes] = useState("1");
  const [confirm, setConfirm] = useState(false);

  const [reloadKey, reload] = useReload();
  const retireGate = useAgreementGate(credential?.address, ["retirement-mandate"]);

  useEffect(() => {
    let ignore = false;
    (async () => {
      const r = await fetch(`/api/market${credential ? `?account=${credential.address}` : ""}`);
      if (!ignore && r.ok) setM(await r.json());
    })();
    return () => { ignore = true; };
  }, [credential, reloadKey]);

  if (!userId || !credential || !config) return <AccountGate />;
  const d = config.deployment;

  async function relay(label: string, calls: Call[]) {
    setBusy(label); setMsg(null); setConfirm(false);
    try {
      const r = await signAndRelay(config!.rpcUrl, credential!, calls);
      setMsg({ kind: "ok", text: `${label}完成 · tx ${r.txHash.slice(0, 10)}… · gas ${Number(r.gasUsed).toLocaleString()}（平台代付）` });
      reload();
    } catch (e) {
      console.error("relay failed", e);
      setMsg({ kind: "error", text: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    } finally { setBusy(null); }
  }

  const beneficiaryHash = (): Hex => keccak256(toBytes(beneficiary || credential!.address));

  const h = m?.holdings;
  const batches = h?.batches ?? [];
  const cctKg = h ? Math.floor(Number(BigInt(h.cct) / 10n ** 15n)) : 0;

  const options: { key: string; label: string; maxKg: number }[] = [
    ...batches.map((b) => ({
      key: `b${b.batchId}`,
      label: `批次 #${b.batchId}　${b.project}　${b.vintageYear}　持有 ${fmtKg(b.kg)}`,
      maxKg: b.kg,
    })),
    ...(cctKg > 0 ? [{ key: "cct", label: `池化額度 CCT　持有 ${fmtKg(cctKg)}（依 FIFO 對應到具體批次）`, maxKg: cctKg }] : []),
  ];
  const sel = options.find((o) => o.key === (target ?? options[0]?.key)) ?? null;
  const kg = sel ? Math.min(sel.maxKg, Math.max(1, Math.round(Number(tonnes) * 1000))) : 0;
  const ready = !!sel && kg > 0 && kg <= sel.maxKg && !!beneficiary.trim() && retireGate.ok && tier !== 1;

  function doRetire() {
    if (!sel) return;
    if (sel.key === "cct") {
      relay(`註銷池化額度 ${fmtKg(kg)}`, [{
        target: d.carbonPool, value: 0n,
        data: encodeFunctionData({ abi: poolAbi, functionName: "redeemAndRetire", args: [BigInt(kg), beneficiaryHash(), beneficiary, purpose, memo] }),
      }]);
      return;
    }
    const batchId = Number(sel.key.slice(1));
    relay(`註銷批次 #${batchId} ${fmtKg(kg)}`, [{
      target: d.carbonCredit1155, value: 0n,
      data: encodeFunctionData({ abi: creditAbi, functionName: "retire", args: [{
        holder: credential!.address, batchId: BigInt(batchId), amountKg: BigInt(kg), certificateTo: credential!.address,
        beneficiaryHash: beneficiaryHash(), beneficiary, purpose, memo,
      }] }),
    }]);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-tide">註銷</p>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-ink-50">註銷並取得憑證</h1>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/portfolio" className="rounded-[--radius-ctl] border border-ink-500 px-3 py-1.5 text-ink-200 transition hover:border-tide/60">我的資產</Link>
          <Link href="/certificates" className="rounded-[--radius-ctl] border border-ink-500 px-3 py-1.5 text-ink-200 transition hover:border-tide/60">我的憑證</Link>
        </div>
      </div>

      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      {tier === 1 ? (
        <Notice kind="info">
          <b>自然人無法註銷額度。</b>環境部的額度帳戶只開給事業（公司、行號、工廠、民間機構、行政機關與各級政府），
          自然人開不了帳戶，也就無法在官方登錄簿完成註銷；若只在鏈上註銷，會產生一張官方端查無紀錄的憑證，
          反而不能拿來申報。您可以持有、也可以隨時到<Link className="text-tide underline" href="/trade">交易</Link>賣出給需要使用的事業。
          若貴單位有統一編號，可到<Link className="text-tide underline" href="/kyc">身分驗證</Link>改以法人身分驗證。
        </Notice>
      ) : tier === 0 ? (
        <Notice kind="info">
          尚未完成身分驗證。請先到<Link className="text-tide underline" href="/kyc">身分驗證</Link>辦理。
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card title="註銷標的">
          {!m ? (
            <p className="text-sm text-ink-300">讀取中…</p>
          ) : options.length === 0 ? (
            <p className="text-sm text-ink-300">
              尚未持有可註銷的額度。到<Link className="text-tide underline" href="/trade">交易</Link>買進後再回來。
            </p>
          ) : (
            <div className="space-y-3">
              <Field label="選擇額度">
                <select className={inputCls} value={sel?.key ?? ""} onChange={(e) => setTarget(e.target.value)}>
                  {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </Field>
              <Field label={`數量（噸，最多 ${sel ? (sel.maxKg / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 3 }) : 0}）`}>
                <input className={inputCls} type="number" step="0.001" min="0.001"
                  max={sel ? sel.maxKg / 1000 : undefined}
                  value={tonnes} onChange={(e) => setTonnes(e.target.value)} />
              </Field>
              <div className="flex gap-1">
                {[1, 5, 10].map((t) => (
                  <button key={t} onClick={() => setTonnes(String(Math.min(sel ? sel.maxKg / 1000 : t, t)))}
                    className="flex-1 rounded border border-ink-500 py-1 text-xs text-ink-300 transition hover:border-tide/60 hover:text-ink-50">{t} 噸</button>
                ))}
                <button onClick={() => sel && setTonnes(String(sel.maxKg / 1000))}
                  className="flex-1 rounded border border-ink-500 py-1 text-xs text-ink-300 transition hover:border-tide/60 hover:text-ink-50">全部</button>
              </div>
            </div>
          )}
        </Card>

        <Card title="憑證內容">
          <div className="space-y-3">
            <Field label="受益人名稱（憑證上顯示）">
              <input className={inputCls} value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} placeholder="某某股份有限公司" />
            </Field>
            <Field label="用途">
              <select className={inputCls} value={purpose} onChange={(e) => setPurpose(Number(e.target.value))}>
                {PURPOSE_LABEL.map((l, i) => <option key={i} value={i}>{l}</option>)}
              </select>
            </Field>
            <Field label="備註">
              <input className={inputCls} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="FY2025" />
            </Field>
            <p className="text-xs leading-6 text-ink-300">
              用途會寫進憑證，也會出現在公告欄。用於碳費扣抵者，另需依碳費收費辦法向主管機關申報。
            </p>
          </div>
        </Card>
      </div>

      <Card title="註銷前請確認">
        <div className="space-y-3">
          <p className="text-sm leading-7 text-ink-200">
            註銷代表這批額度<b>永久退出流通，不可回復、不能再賣出</b>。額度平時登錄在專案方於環境部開立的額度帳戶內，
            您按下註銷後，由本站代辦那唯一一次官方移轉（專案方 → 您的額度帳戶），再由您完成註銷。
            依規定主管機關於註銷次日起五個工作日內公開，
            <b>公開後才可以對外做碳中和之類的宣告</b>；以今天送出計，可對外宣告日約為 {announceableFrom()}。
            憑證上會標示可對外宣告日與官方註銷文號。
          </p>
          {tier === 2 && <AgreementCheck gate={retireGate} />}
          <Button onClick={() => setConfirm(true)} disabled={!!busy || !ready} className="w-full sm:w-auto">
            註銷並取得憑證
          </Button>
        </div>
      </Card>

      {confirm && sel && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/70 p-4 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-label="確認註銷">
          <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-[--radius-card] border border-ink-500 bg-ink-700 p-5 shadow-xl">
            <h2 className="font-display text-lg font-semibold text-ink-50">確認註銷</h2>
            <dl className="mt-4 divide-y divide-ink-500 text-sm">
              {([
                ["標的", sel.label.split("　").slice(0, 2).join("　")],
                ["數量", fmtKg(kg)],
                ["受益人", beneficiary],
                ["用途", PURPOSE_LABEL[purpose]],
                ["備註", memo || "—"],
                ["可對外宣告日（預估）", announceableFrom()],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 py-2">
                  <dt className="text-ink-300">{k}</dt>
                  <dd className="tnum text-right font-medium text-ink-50">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-xs leading-6 text-ink-300">
              按下確認後會立刻以 passkey 簽章並上鏈。<b className="text-ink-200">註銷不可回復</b>，
              這批額度將無法再交易，並由本站代您向主管機關辦理官方移轉與註銷登錄。
            </p>
            <div className="mt-5 flex gap-2">
              <Button variant="secondary" onClick={() => setConfirm(false)} className="flex-1">返回修改</Button>
              <Button onClick={async () => { await retireGate.accept(sel.key); doRetire(); }} disabled={!!busy} className="flex-1">
                {busy ? "簽章中…" : "以 passkey 簽章註銷"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
