"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAccount } from "./AccountProvider";
import { Button } from "./ui";

/// 費思：站內的對話助理。掛在 layout，所以每一頁都在。
///
/// 三件事：解說畫面上的資訊、回答查得到的問題、以及**代為操作**。
/// 前兩件在伺服器端用工具查真實資料（見 lib/server/faith/tools.ts），
/// 第三件是這個元件真正的重點——所以先講清楚代操這條路是怎麼設計的。
///
/// ## 為什麼確認卡才是那道關卡
///
/// 每一筆代操最後都會跳 passkey。但**作業系統的 passkey 視窗上看不到金額、
/// 對手與數量**——它只問「要用 Face ID 確認嗎」。如果那是唯一的關卡，
/// 它實際上在問的是「你信不信任剛才那段對話」，而使用者無從核對。
///
/// 所以真正的關卡在前面一步：一張由**伺服器端**重新算出來的確認卡，
/// 上面是數量、單價、總價、手續費、對手與餘額變化。費思講錯話會被這張卡擋下來，
/// 因為卡上的數字不是它說的。
///
/// 而且按下確認的那一刻會**再算一次**（/api/faith/act）。從提議到確認之間
/// 可能過了幾分鐘，掛單會被別人吃掉、餘額會變。數字變了就換一張卡、重新要求確認，
/// 不會拿一份過期的 calldata 去簽。

type Row = { label: string; value: string; emphasis?: boolean };
type Action = {
  kind: string; title: string; rows: Row[]; warnings: string[];
  href?: string; calls?: { target: `0x${string}`; value: string; data: `0x${string}` }[];
  /// 提議時用的參數。確認時拿它重算，不從畫面上的文字反推。
  params?: Record<string, unknown>;
  why?: string;
};
type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; action?: Action; done?: string; failed?: string };

const SUGGESTIONS: Record<string, string[]> = {
  "/": ["這個地球在顯示什麼？", "哪一國的額度最便宜？", "我要怎麼開始？"],
  "/about": ["國外額度可以扣碳費嗎？", "什麼是外加性？", "ISO 14064 三個部分差在哪？"],
  "/trade": ["這一頁怎麼看？", "現在台灣額度最低價多少？", "幫我掛一張 1 噸的買單"],
  "/portfolio": ["我的損益怎麼算的？", "我手上有哪些批次？"],
  "/retire": ["註銷之後會發生什麼事？", "我可以選哪些用途？"],
  "/account": ["我掉了手機該怎麼辦？", "所有裝置都遺失怎麼救？"],
  "/agreements": ["約定書怎麼寫金鑰遺失？", "隱私權政策收集了什麼？"],
};
const DEFAULT_SUGGESTIONS = ["這一頁在做什麼？", "碳權是什麼？", "我的身分驗證過了嗎？"];

function Rows({ rows }: { rows: Row[] }) {
  return (
    <dl className="mt-2 space-y-1">
      {rows.map((r, i) => (
        <div key={i} className="flex items-baseline justify-between gap-3 text-xs">
          <dt className="shrink-0 text-ink-300">{r.label}</dt>
          <dd className={`text-right ${r.emphasis ? "font-mono text-sm font-semibold text-ink-50" : "text-ink-200"}`}>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Faith() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const path = usePathname();
  const router = useRouter();
  const { relay, credential, refreshWallet } = useAccount();
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ⌘K / Ctrl-K 開關。全站都在的東西要有一個不必找滑鼠的入口。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((v) => !v); }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 新訊息就捲到底。這是 DOM 操作不是 setState，所以放 effect 裡沒問題。
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgs, busy]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const ask = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setInput("");
    // 歷史只送純文字：確認卡與執行結果是**我們這邊**的狀態，
    // 送回給模型只會讓它以為那些是它說的話，然後開始宣布自己完成了什麼。
    const history = [...msgs, { role: "user" as const, content: q }];
    setMsgs(history);
    setBusy(true);
    try {
      const r = await fetch("/api/faith", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, messages: history.map((m) => ({ role: m.role, content: m.content })) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "費思沒有回應");
      setMsgs((m) => [...m, { role: "assistant", content: j.reply ?? "", action: j.action }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", content: e instanceof Error ? e.message : String(e) }]);
    } finally { setBusy(false); }
  }, [busy, msgs, path]);

  /// 確認並執行。順序刻意是「重算 → 比對 → 有變就停下來 → 簽」。
  const confirm = useCallback(async (idx: number, a: Action) => {
    setBusy(true);
    try {
      if (a.href) { router.push(a.href); setOpen(false); return; }

      // ① 重算。過了幾分鐘的掛單、餘額、身分都可能不一樣了。
      const r = await fetch("/api/faith/act", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: a.kind, params: a.params ?? {} }),
      });
      const fresh = (await r.json()) as Action & { error?: string };
      if (!r.ok) throw new Error(fresh.error ?? "這個動作現在做不了");

      // ② 比對。數字變了就換一張卡、重新要求確認——不要拿使用者沒看過的條件去簽。
      if (JSON.stringify(fresh.rows) !== JSON.stringify(a.rows)) {
        setMsgs((m) => m.map((x, i) => (i === idx && x.role === "assistant"
          ? { ...x, action: { ...fresh, params: a.params, why: a.why }, content: "條件在你確認之前變了（多半是那張單被別人動過）。這是現在的數字，請再看一次。" }
          : x)));
        return;
      }

      // ③ 執行。三條路：平台代送、領水、以及需要 passkey 簽章的那一類。
      let note = "";
      if (a.kind === "freeze_wallet") {
        const res = await fetch("/api/account/freeze", { method: "POST" });
        if (!res.ok) throw new Error((await res.json()).error ?? "凍結失敗");
        refreshWallet();
        note = "錢包已凍結。解凍要一把還在錢包裡的 passkey。";
      } else if (a.kind === "claim_faucet") {
        if (!credential) throw new Error("這台裝置沒有 passkey，無法領取");
        const res = await fetch("/api/faucet", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ account: credential.address }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "領取失敗");
        note = "已領取測試用 mTWD。";
      } else {
        if (!fresh.calls?.length) throw new Error("這個動作沒有可執行的內容");
        const out = await relay(fresh.calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data })));
        note = `已送出，交易 ${out.txHash.slice(0, 10)}…`;
      }
      setMsgs((m) => m.map((x, i) => (i === idx && x.role === "assistant" ? { ...x, action: undefined, done: note } : x)));
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setMsgs((m) => m.map((x, i) => (i === idx && x.role === "assistant" ? { ...x, failed: why } : x)));
    } finally { setBusy(false); }
  }, [relay, router, credential, refreshWallet]);

  const suggestions = SUGGESTIONS[path ?? "/"] ?? DEFAULT_SUGGESTIONS;

  return (
    <>
      {/* 常駐入口。右下角是慣例，但不要蓋住頁尾的連結，所以在手機上位置抬高一點。 */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          data-testid="faith-open"
          aria-label="開啟費思助理（⌘K）"
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-tide/40 bg-ink-700 px-4 py-2.5 text-sm text-ink-50 shadow-lg transition hover:border-tide"
        >
          <Spark className="h-4 w-4 text-tide" />
          <span className="font-display font-semibold">費思</span>
          <kbd className="hidden rounded border border-ink-500 px-1 text-[10px] text-ink-300 sm:inline">⌘K</kbd>
        </button>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-ink-900/40 sm:inset-auto sm:bottom-5 sm:right-5 sm:h-[min(620px,calc(100vh-3rem))] sm:w-[min(420px,calc(100vw-2.5rem))] sm:bg-transparent"
          role="dialog" aria-label="費思"
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-ink-500 bg-ink-700 sm:rounded-[--radius-card] sm:border sm:shadow-2xl">
            <header className="flex items-center justify-between gap-2 border-b border-ink-500 px-4 py-3">
              <span className="flex items-center gap-2">
                <Spark className="h-4 w-4 text-tide" />
                <span className="font-display text-sm font-semibold text-ink-50">費思</span>
                <span className="text-[11px] text-ink-300">站內助理</span>
              </span>
              <button onClick={() => setOpen(false)} aria-label="關閉" className="rounded-[--radius-ctl] border border-ink-500 px-2 py-1 text-xs text-ink-300 transition hover:text-ink-50">
                關閉
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" data-testid="faith-log">
              {msgs.length === 0 && (
                <div className="space-y-3">
                  <p className="text-xs leading-6 text-ink-200">
                    我可以解說這一頁上的資訊、查行情與你的持倉、引用契約條文，也可以幫你下單——
                    但每一筆都會先給你一張確認卡，你按了才送出。
                  </p>
                  <p className="text-[11px] leading-5 text-ink-300">
                    我不提供投資建議，也不碰你的 passkey。
                  </p>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {suggestions.map((s) => (
                      <button key={s} onClick={() => ask(s)} className="rounded-full border border-ink-500 px-2.5 py-1 text-[11px] text-ink-300 transition hover:border-tide/60 hover:text-ink-50">
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {msgs.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
                  {m.role === "user" ? (
                    <p className="max-w-[85%] whitespace-pre-wrap rounded-[--radius-ctl] bg-ink-600 px-3 py-2 text-xs leading-6 text-ink-50">{m.content}</p>
                  ) : (
                    <div className="space-y-2">
                      {m.content && <p className="whitespace-pre-wrap text-xs leading-6 text-ink-200">{m.content}</p>}

                      {m.action && (
                        <div data-testid="faith-confirm" className="rounded-[--radius-card] border border-tide/40 bg-ink-800 p-3">
                          <p className="font-display text-sm font-semibold text-ink-50">{m.action.title}</p>
                          <Rows rows={m.action.rows} />
                          {m.action.warnings.length > 0 && (
                            <ul className="mt-2 space-y-1 border-l-2 border-warn/50 pl-2">
                              {m.action.warnings.map((w, k) => (
                                <li key={k} className="text-[11px] leading-5 text-warn">{w}</li>
                              ))}
                            </ul>
                          )}
                          <div className="mt-3 flex gap-2">
                            <Button className="flex-1 !py-1.5 !text-xs" disabled={busy} onClick={() => confirm(i, m.action!)} data-testid="faith-do">
                              {busy ? "處理中…" : m.action.href ? "帶我過去" : "確認並簽署"}
                            </Button>
                            <Button
                              variant="secondary" className="!py-1.5 !text-xs" disabled={busy}
                              onClick={() => setMsgs((x) => x.map((y, k) => (k === i && y.role === "assistant" ? { ...y, action: undefined } : y)))}
                            >
                              取消
                            </Button>
                          </div>
                          <p className="mt-2 text-[10px] leading-4 text-ink-300">
                            這些數字是伺服器重新算的，不是費思說的。按下確認後還要通過這台裝置的 passkey。
                          </p>
                        </div>
                      )}

                      {m.done && <p className="rounded-[--radius-ctl] border border-up/40 bg-up/10 px-2.5 py-1.5 text-[11px] text-up">{m.done}</p>}
                      {m.failed && <p className="rounded-[--radius-ctl] border border-down/40 bg-down/10 px-2.5 py-1.5 text-[11px] text-down">{m.failed}</p>}
                    </div>
                  )}
                </div>
              ))}

              {busy && <p className="text-[11px] text-ink-300">費思思考中…</p>}
              <div ref={endRef} />
            </div>

            <form
              className="border-t border-ink-500 p-3"
              onSubmit={(e) => { e.preventDefault(); ask(input); }}
            >
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter 送出、Shift+Enter 換行。對話框裡這是大家的肌肉記憶。
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input); }
                  }}
                  placeholder="問費思，或請他幫你做一件事…"
                  aria-label="問費思"
                  data-testid="faith-input"
                  className="max-h-28 min-h-[38px] flex-1 resize-none rounded-[--radius-ctl] border border-ink-500 bg-ink-800 px-3 py-2 text-xs leading-6 text-ink-50 outline-none placeholder:text-ink-300 focus:border-tide"
                />
                <Button type="submit" className="!px-3 !py-2 !text-xs" disabled={busy || !input.trim()}>送出</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function Spark({ className = "" }: { className?: string }) {
  // 自己畫的小記號，不引外部圖示集——少一個相依，也不會在淺色模式變不見。
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" aria-hidden>
      <path d="M8 1.5l1.5 4.2 4.2 1.5-4.2 1.5L8 12.9 6.5 8.7 2.3 7.2l4.2-1.5L8 1.5z" fill="currentColor" />
      <circle cx="13" cy="12.5" r="1.4" fill="currentColor" opacity=".6" />
    </svg>
  );
}
