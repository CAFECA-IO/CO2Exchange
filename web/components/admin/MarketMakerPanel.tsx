"use client";
import { useEffect, useState } from "react";
import { useReload } from "@/lib/client/useReload";
import { StatTile } from "@/components/charts";
import { Button, Card, Field, Notice, fmtKg, inputCls } from "@/components/ui";
import { fetchJson, postJson } from "@/lib/client/fetchJson";

/// 後台做市控制頁。
///
/// 這一頁**不送交易**：按下去只是把設定寫進 web/data/mm/config.json，由常駐程式
/// （`npm run mm`）下一輪讀到後執行。所以每一個按鈕的結果都要回頭看狀態區，
/// 不能看按鈕有沒有變綠——那只代表設定存進去了。

type Quote = { id: number; pricePerTonne: number; kg: number; batchId?: number };
type Status = {
  heartbeatAt?: string; action?: string; halted?: { reason: string; at: string } | null;
  marketMaker?: string; operator?: string; chainId?: number;
  ref?: { pricePerTonne: number; source: string };
  cash?: number; bidEscrow?: number; inventoryKg?: number; freeInventoryKg?: number; equity?: number; pnl?: number; dayPnl?: number;
  fundedTotal?: number; capitalTWD?: number; feeBps?: number; gas?: number; intervalSec?: number;
  /// 帳本 v2：報價是簽名委託單（"ledger"）
  venue?: string;
  quotes?: { bids: Quote[]; asks: Quote[] };
  externalBest?: { bid: number | null; ask: number | null };
  simulation?: { allowed: boolean; requested: boolean; running: boolean; lastExit: { code: number | null; at: string } | null };
  warnings?: string[]; recent?: { at: string; msg: string }[]; lastError?: { at: string; msg: string };
};
type Config = {
  enabled: boolean; capitalTWD: number; maxInventoryTonnes: number; maxOrderTonnes: number; levels: number;
  spreadBps: number; stepBps: number; anchorPricePerTonne: number; floorPerTonne: number; ceilPerTonne: number;
  maxDailyLossTWD: number; requoteBps: number; intervalSec: number; minFillTonnes: number;
  simulation: { enabled: boolean; users: number; intervalSec: number };
  updatedAt?: string; updatedBy?: string;
};
type Resp = { chainId: number; simulationAllowed: boolean; simulationChains: number[]; config: Config; status: Status | null; alive: boolean; ageSec: number | null; sameChain: boolean };

const FIELDS: { key: keyof Config; label: string; unit: string; hint: string }[] = [
  { key: "capitalTWD", label: "撥款上限", unit: "元", hint: "累計撥給做市帳戶的新台幣（營運 Safe 確認的入金）不超過這個數。虧掉的不會自動補" },
  { key: "maxInventoryTonnes", label: "持有部位上限", unit: "噸", hint: "含掛在簿子上的賣單" },
  { key: "maxOrderTonnes", label: "單筆報價上限", unit: "噸", hint: "" },
  { key: "levels", label: "每側檔數", unit: "檔", hint: "1–10" },
  { key: "spreadBps", label: "最內層價差", unit: "bps", hint: "買賣兩價的總寬度；半邊要大於手續費" },
  { key: "stepBps", label: "每檔加寬", unit: "bps", hint: "" },
  { key: "anchorPricePerTonne", label: "錨價", unit: "元／噸", hint: "沒有成交與外部報價時用" },
  { key: "floorPerTonne", label: "報價下限", unit: "元／噸", hint: "" },
  { key: "ceilPerTonne", label: "報價上限", unit: "元／噸", hint: "" },
  { key: "maxDailyLossTWD", label: "單日停損", unit: "元", hint: "台北時間一天內權益跌超過就撤單停止；0 = 不設" },
  { key: "requoteBps", label: "重掛門檻", unit: "bps", hint: "與目標價差超過才撤單重掛" },
  { key: "minFillTonnes", label: "最小成交量", unit: "噸", hint: "" },
  { key: "intervalSec", label: "每輪間隔", unit: "秒", hint: "外部鏈每筆交易要等出塊，不宜太短" },
];

const money = (n?: number) => (n === undefined ? "—" : n.toLocaleString("zh-TW", { maximumFractionDigits: 0 }));
const signed = (n?: number) => (n === undefined ? "—" : `${n >= 0 ? "+" : "−"}${money(Math.abs(n))}`);

function stateLabel(r: Resp): { text: string; kind: "ok" | "warn" | "error" | "info" } {
  if (!r.status?.heartbeatAt) return { text: "常駐程式從未執行", kind: "warn" };
  if (!r.sameChain) return { text: `狀態屬於另一條鏈（chainId ${r.status.chainId}）`, kind: "error" };
  if (!r.alive) return { text: `常駐程式沒有回應（最後心跳 ${r.ageSec} 秒前）`, kind: "error" };
  if (r.status.halted) return { text: "已停止報價", kind: "warn" };
  if (!r.config.enabled) return { text: "做市已關閉", kind: "info" };
  return { text: "報價中", kind: "ok" };
}

export function MarketMakerPanel() {
  const [r, setR] = useState<Resp | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [sim, setSim] = useState<{ users: string; intervalSec: string } | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [reloadKey, reload] = useReload();
  useEffect(() => {
    let ignore = false;
    const run = async () => {
      try {
        const j = await fetchJson<Resp>("/api/admin/market-maker");
        if (ignore) return;
        setR(j);
        // 表單只在第一次載入時帶入目前值；之後每十秒的刷新不能蓋掉正在編輯的內容
        setDraft((d) => (Object.keys(d).length ? d : Object.fromEntries(FIELDS.map((f) => [f.key, String(j.config[f.key])]))));
        setSim((x) => x ?? { users: String(j.config.simulation.users), intervalSec: String(j.config.simulation.intervalSec) });
      } catch (e) {
        if (!ignore) setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      }
    };
    run();
    const t = setInterval(run, 10_000);
    return () => { ignore = true; clearInterval(t); };
  }, [reloadKey]);

  async function act(label: string, body: unknown) {
    setBusy(label); setMsg(null);
    try {
      const j = await postJson<Resp>("/api/admin/market-maker", body);
      setR((cur) => (cur ? { ...cur, ...j } : cur));
      setMsg({ kind: "ok", text: `${label}：已寫入設定，常駐程式下一輪（約 ${r?.config.intervalSec ?? 60} 秒內）生效` });
      reload();
    } catch (e) { setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  }

  if (!r) return <Card title="後台做市"><p className="text-sm text-ink-300">讀取中…</p></Card>;
  const s = r.status ?? {};
  const st = stateLabel(r);
  const dirty = FIELDS.some((f) => draft[f.key] !== undefined && draft[f.key] !== String(r.config[f.key]));

  return (
    <div className="space-y-4" data-testid="mm-panel">
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <Card
        title="後台做市"
        action={<span className={`rounded px-2 py-0.5 text-xs ${st.kind === "ok" ? "bg-up/15 text-up" : st.kind === "error" ? "bg-down/15 text-down" : st.kind === "warn" ? "bg-warn/15 text-warn" : "bg-ink-600 text-ink-200"}`} data-testid="mm-state">{st.text}</span>}
      >
        <p className="mb-3 text-xs text-ink-300">
          做市帳戶只被動報價、不主動吃單，也不與任何平台控制的帳戶（營運金鑰、模擬人物）成交。
          這一頁只寫設定；實際的報價由常駐程式 <code>npm run mm</code> 執行，網站不持有做市金鑰。
        </p>
        {!r.alive && (
          <Notice kind="warn">
            常駐程式沒有在跑。在伺服器上執行 <code>cd web &amp;&amp; npm run mm</code>，或依 README「後台做市」安裝成 launchd／systemd 服務。
          </Notice>
        )}
        {s.halted && <div className="mt-2"><Notice kind="warn">停止原因：{s.halted.reason}（{new Date(s.halted.at).toLocaleString("zh-TW")}）</Notice></div>}
        {s.lastError && r.alive && <div className="mt-2"><Notice kind="error">上一輪失敗：{s.lastError.msg}</Notice></div>}
        {(s.warnings ?? []).length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-warn">{s.warnings!.map((w) => <li key={w}>⚠ {w}</li>)}</ul>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {r.config.enabled
            ? <Button variant="secondary" disabled={!!busy} onClick={() => act("停止報價", { action: "stop" })}>停止報價</Button>
            : <Button disabled={!!busy || r.config.capitalTWD <= 0} onClick={() => act("啟動報價", { action: "start" })} data-testid="mm-start">啟動報價</Button>}
          {s.halted && <Button disabled={!!busy} onClick={() => act("恢復", { action: "resume" })}>恢復</Button>}
          <Button
            variant="secondary" disabled={!!busy}
            onClick={() => { if (window.confirm(s?.venue === "ledger"
              ? "撤回所有報價並停止做市？做市帳戶在帳本裡的新台幣會全部申請出金到公司帳戶，下一期承諾上鏈後由營運 Safe 確認；持有的碳權留在做市帳戶。"
              : "撤回所有報價，並把做市帳戶的新台幣全部申請出金到公司帳戶？持有的碳權會留在做市帳戶。")) act("收回資金", { action: "recall" }); }}
          >收回資金</Button>
        </div>
        {r.config.capitalTWD <= 0 && !r.config.enabled && <p className="mt-2 text-xs text-ink-300">先在下方設定撥款上限，才能啟動。</p>}
      </Card>

      {s.heartbeatAt && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="參考價" value={s.ref ? `${money(s.ref.pricePerTonne)}` : "—"} sub={s.ref ? `元／噸 · ${s.ref.source}` : undefined} />
            <StatTile label="權益" value={money(s.equity)} sub={`已撥款 ${money(s.fundedTotal)} / 上限 ${money(r.config.capitalTWD)} 元`} />
            <StatTile label="累計損益" value={signed(s.pnl)} accent={(s.pnl ?? 0) >= 0 ? "up" : "down"} sub="已扣除撥款" />
            <StatTile label="今日損益" value={signed(s.dayPnl)} accent={(s.dayPnl ?? 0) >= 0 ? "up" : "down"} sub={r.config.maxDailyLossTWD ? `停損 ${money(r.config.maxDailyLossTWD)} 元` : "未設停損"} />
            <StatTile label="現金" value={money(s.cash)} sub={`另有 ${money(s.bidEscrow)} 元鎖在買單`} />
            <StatTile label="持有" value={fmtKg(s.inventoryKg ?? 0)} sub={`未上架 ${fmtKg(s.freeInventoryKg ?? 0)} · 上限 ${r.config.maxInventoryTonnes} 噸`} />
            <StatTile label="外部最佳價" value={`${s.externalBest?.bid == null ? "—" : money(s.externalBest.bid)} / ${s.externalBest?.ask == null ? "—" : money(s.externalBest.ask)}`} sub="買 / 賣（元／噸，不含平台帳戶）" />
            <StatTile label="手續費" value={`${s.feeBps ?? "—"} bps`} sub={`gas 餘額 ${s.gas?.toFixed(4) ?? "—"}`} />
          </div>

          <Card title="目前報價">
            <div className="grid gap-4 md:grid-cols-2">
              {(["bids", "asks"] as const).map((side) => (
                <div key={side}>
                  <h3 className={`mb-1 text-sm font-medium ${side === "bids" ? "text-up" : "text-down"}`}>{side === "bids" ? "買單" : "賣單"}</h3>
                  {(s.quotes?.[side] ?? []).length === 0 ? <p className="text-xs text-ink-300">沒有{side === "bids" ? "買單" : "賣單"}{side === "asks" ? "（還沒有庫存時只會掛買單）" : ""}</p> : (
                    <table className="w-full text-xs">
                      <thead className="text-left text-ink-300"><tr><th className="py-1">#</th><th className="text-right">價格／噸</th><th className="text-right">數量</th>{side === "asks" && <th className="text-right">批次</th>}</tr></thead>
                      <tbody>{s.quotes![side].map((q) => (
                        <tr key={q.id} className="border-t border-ink-500"><td className="py-1">{q.id}</td><td className="tnum text-right">{money(q.pricePerTonne)}</td><td className="tnum text-right">{fmtKg(q.kg)}</td>{side === "asks" && <td className="text-right">#{q.batchId}</td>}</tr>
                      ))}</tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-3 font-mono text-[11px] text-ink-300">做市帳戶 {s.marketMaker} · 營運金鑰 {s.operator} · 心跳 {r.ageSec ?? "—"} 秒前</p>
          </Card>
        </>
      )}

      <Card title="參數" action={r.config.updatedAt && <span className="text-[11px] text-ink-300">上次修改 {new Date(r.config.updatedAt).toLocaleString("zh-TW")} · {r.config.updatedBy}</span>}>
        <div className="grid gap-3 md:grid-cols-3">
          {FIELDS.map((f) => (
            <Field key={f.key} label={`${f.label}（${f.unit}）`}>
              <input className={inputCls} inputMode="decimal" value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} data-testid={`mm-${f.key}`} />
              {f.hint && <span className="mt-0.5 block text-[11px] text-ink-300">{f.hint}</span>}
            </Field>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <Button disabled={!!busy || !dirty} onClick={() => act("儲存參數", { action: "save", config: draft })} data-testid="mm-save">儲存參數</Button>
          <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(r.config[f.key])])))}>還原</Button>
        </div>
      </Card>

      <Card title="模擬交易（僅測試鏈）">
        {r.simulationAllowed ? (
          <>
            <p className="mb-3 text-xs text-ink-300">
              讓虛擬人物彼此買賣，維持測試環境的市場熱度。模擬人物的掛單在掛單簿上標示「模擬」，
              而且它們看不見做市帳戶的單——兩者不會互相成交。chainId {r.chainId} 在允許清單（{r.simulationChains.join(", ")}）內。
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="人數（1–100）"><input className={inputCls} value={sim?.users ?? ""} onChange={(e) => setSim({ ...sim!, users: e.target.value })} /></Field>
              <Field label="每輪間隔（秒）"><input className={inputCls} value={sim?.intervalSec ?? ""} onChange={(e) => setSim({ ...sim!, intervalSec: e.target.value })} /></Field>
              <div className="flex items-end gap-2">
                {r.config.simulation.enabled
                  ? <Button variant="secondary" disabled={!!busy} onClick={() => act("停止模擬", { action: "simulation", enabled: false })}>停止模擬</Button>
                  : <Button disabled={!!busy} onClick={() => act("啟動模擬", { action: "simulation", enabled: true, users: sim?.users, intervalSec: sim?.intervalSec })}>啟動模擬</Button>}
              </div>
            </div>
            <p className="mt-2 text-xs text-ink-300">
              目前：{s.simulation?.running ? "執行中" : r.config.simulation.enabled ? "已要求啟動，等常駐程式下一輪" : "未執行"}
              {s.simulation?.lastExit && ` · 上次結束 ${new Date(s.simulation.lastExit.at).toLocaleString("zh-TW")}（exit ${s.simulation.lastExit.code}）`}
              。紀錄在 <code>web/data/mm/simulation.log</code>。
            </p>
          </>
        ) : (
          <Notice>chainId {r.chainId} 不在允許清單（{r.simulationChains.join(", ")}），這條鏈不能開模擬交易。這是刻意的：正式市場上不可以有平台自己的虛擬成交。</Notice>
        )}
      </Card>

      {(s.recent ?? []).length > 0 && (
        <Card title="最近事件">
          <ul className="space-y-1 text-xs">{s.recent!.map((e, i) => <li key={i}><span className="text-ink-300">{new Date(e.at).toLocaleString("zh-TW")}</span> {e.msg}</li>)}</ul>
        </Card>
      )}
    </div>
  );
}
