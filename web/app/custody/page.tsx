"use client";
import { useEffect, useState } from "react";
import { BarList, StatTile } from "@/components/charts";
import { Card, Notice, fmtKg } from "@/components/ui";
import { flagOf } from "@/lib/deployment";
import type { Custody } from "@/lib/server/reserve";

/// 託管與資產稽核揭露。
///
/// 這一頁在回答一個問題：**你們說鏈上這些額度是真的，憑什麼？**
///
/// 憑據有兩層。第一層是本頁自己算的：鏈上每一公噸都來自一筆核發事件，減掉註銷，
/// 依核發國分組——這個數字誰都可以自己重算，不必相信我們。第二層是每月 5 日的對帳報告：
/// 各國官方登錄簿託管帳戶裡實際有多少、信託專戶裡實際有多少，由查核機構簽署後上鏈。
///
/// 兩層並列顯示，不合併。合併之後就看不出「我們說的」與「可驗證的」哪裡不一樣了。

const STATUS = [
  { label: "待查核", cls: "text-warn", desc: "營運方已填報，尚未經查核機構簽署" },
  { label: "已查核相符", cls: "text-up", desc: "查核機構已簽署，託管餘額與鏈上數量相符" },
  { label: "已查核有差異", cls: "text-down", desc: "查核機構已簽署，但發現差異，說明見下方" },
] as const;

const twd = (v: string | number) => (Number(v) / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 0 });
const period = (p: number) => `${Math.floor(p / 100)} 年 ${p % 100} 月`;
const short = (h: string) => (h && !/^0x0+$/.test(h) ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");

export default function CustodyPage() {
  const [c, setC] = useState<Custody | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/custody")
      .then((r) => r.json())
      .then((j) => (j.error ? setErr(j.error) : setC(j)))
      .catch((e) => setErr(String(e)));
  }, []);

  const r = c?.latest;
  const st = r ? STATUS[r.status] ?? STATUS[0] : null;
  const liveTotalKg = (c?.live ?? []).reduce((s, x) => s + x.circulatingKg, 0);
  const heldTotalKg = (r?.credits ?? []).reduce((s, x) => s + x.heldKg, 0);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-tide">託管與稽核</p>
        <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-ink-50">資產託管揭露</h1>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-ink-200">
          本站不自己保管碳權，也不自己保管錢。
          <b>碳權</b>存放在各國政府的官方登錄簿帳戶裡——臺灣是環境部「溫室氣體減量額度管理系統」的額度帳戶，
          日本是Ｊ－クレジット登録簿，其餘依此類推；鏈上的每一公噸，都要對得到某一國登錄簿裡的一公噸。
          <b>入金</b>存放在信託機構的信託專戶，與本站自有資金分離，鏈上結算幣的發行量要對得到專戶餘額。
          每月 <b>5 日</b>發布一次對帳報告並由查核機構簽署上鏈；定稿之後不能修改，要更正只能發新的一份，舊的留著。
        </p>
      </div>

      {err && <Notice kind="error">{err}</Notice>}
      {!c ? <p className="text-sm text-ink-300">讀取中…</p> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="最新揭露期別" value={r ? period(r.period) : "尚未發布"} sub={r ? `基準日 ${new Date(r.asOf * 1000).toLocaleDateString("zh-TW")}` : "第一份報告發布後顯示"} />
            <StatTile
              label="稽核狀態"
              value={st?.label ?? "—"}
              accent={r?.status === 1 ? "up" : r?.status === 2 ? "down" : "neutral"}
              sub={r?.auditorName || st?.desc}
            />
            <StatTile label="託管總量" value={r ? fmtKg(heldTotalKg) : "—"} sub={`鏈上流通 ${fmtKg(liveTotalKg)}`} />
            <StatTile label="下次揭露" value={c.nextDisclosure} sub="每月 5 日" />
          </div>

          {r && r.note && (
            <Notice kind={r.status === 2 ? "error" : "info"}>
              <b>查核意見（{r.auditorName || "查核機構"}）：</b>{r.note}
            </Notice>
          )}

          <Card title="碳權託管：各國政府登錄簿帳戶" action={<span className="text-xs text-ink-300">託管餘額 vs 鏈上流通量</span>}>
            {!r ? (
              <p className="text-sm text-ink-300">尚未發布第一份對帳報告。下方的鏈上流通量仍可即時查核。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-ink-300">
                    <tr className="border-b border-ink-500">
                      <th className="py-2 pr-3 font-medium">轄區</th>
                      <th className="py-2 pr-3 font-medium">託管機關／登錄簿</th>
                      <th className="py-2 pr-3 font-medium">帳戶</th>
                      <th className="py-2 pr-3 text-right font-medium">託管餘額</th>
                      <th className="py-2 pr-3 text-right font-medium">鏈上流通（即時）</th>
                      <th className="py-2 pr-3 text-right font-medium">基準日後異動</th>
                      <th className="py-2 font-medium">餘額證明</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-500">
                    {r.credits.map((row) => {
                      // 報告是基準日的快照；之後的核發與註銷會讓即時流通量與託管餘額不同。
                      // 這不是「帳不符」，所以不用警示色——真正的帳差由查核機構在意見欄指出。
                      const diff = row.liveOnchainKg - row.heldKg;
                      return (
                        <tr key={row.country} className="text-ink-200">
                          <td className="py-2 pr-3 whitespace-nowrap">
                            <span className="mr-1.5">{flagOf(row.country)}</span>{row.country}
                          </td>
                          <td className="py-2 pr-3">{row.custodian}</td>
                          <td className="tnum py-2 pr-3 font-mono text-xs">{row.accountRef}</td>
                          <td className="tnum py-2 pr-3 text-right text-ink-50">{fmtKg(row.heldKg)}</td>
                          <td className="tnum py-2 pr-3 text-right">{fmtKg(row.liveOnchainKg)}</td>
                          <td className="tnum py-2 pr-3 text-right text-ink-300">
                            {diff === 0 ? "—" : `${diff > 0 ? "+" : "−"}${fmtKg(Math.abs(diff))}`}
                          </td>
                          <td className="py-2 font-mono text-xs text-ink-300">{short(row.statementHash)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs leading-6 text-ink-300">
              「鏈上流通（即時）」這一欄不是報告填的數字，是本頁用鏈上核發與註銷事件當場算出來的。
              兩欄並列，才看得出報告有沒有對上事實。託管餘額本身要靠登錄簿的餘額證明，其檔案雜湊列在最後一欄。
              報告是<b>基準日的快照</b>，基準日之後的核發、買賣與註銷都不在裡面——所以「基準日後異動」
              有數字是正常的，那不是帳差。真正的帳差由查核機構在意見欄指出，並把狀態標成「已查核有差異」。
            </p>
          </Card>

          <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
            <Card title="入金託管：信託專戶">
              {!r ? <p className="text-sm text-ink-300">尚未發布。</p> : (
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-4"><dt className="text-ink-300">信託機構</dt><dd className="text-ink-50">{r.cash.trustee}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-ink-300">信託專戶</dt><dd className="tnum font-mono text-xs text-ink-200">{r.cash.accountRef}</dd></div>
                  <div className="flex justify-between gap-4 border-t border-ink-500 pt-2">
                    <dt className="text-ink-300">專戶餘額</dt><dd className="tnum font-medium text-ink-50">{twd(r.cash.balance)} mTWD</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-300">鏈上發行量（報告）</dt><dd className="tnum text-ink-200">{twd(r.cash.tokenSupply)} mTWD</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-300">鏈上發行量（即時）</dt><dd className="tnum text-ink-200">{twd(c.liveTokenSupply)} mTWD</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-300">對帳單雜湊</dt><dd className="font-mono text-xs text-ink-300">{short(r.cash.statementHash)}</dd>
                  </div>
                </dl>
              )}
              <p className="mt-3 border-t border-ink-500 pt-3 text-xs leading-6 text-ink-300">
                入金不進本站的自有帳戶。使用者的錢在信託專戶裡，本站倒了也不屬於本站的財產。
                Phase 0 的結算幣是測試代幣，這裡的數字只是把機制跑一次給你看。
              </p>
            </Card>

            <Card title="鏈上流通量（依核發國）" action={<span className="text-xs text-ink-300">即時，不經報告</span>}>
              <BarList
                unit=" 噸"
                rows={c.live.map((j) => ({
                  label: `${flagOf(j.country)} ${j.name}　${j.scheme}`,
                  value: j.circulatingKg / 1000,
                  hint: j.registryName,
                }))}
              />
              <p className="mt-3 text-xs leading-6 text-ink-300">
                核發減註銷。這串數字完全來自鏈上事件，任何人都可以自己重算，不必相信本站的說法。
              </p>
            </Card>
          </div>

          {r && (
            <Card title="這一期報告">
              <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                <div className="flex justify-between gap-4"><dt className="text-ink-300">報告編號</dt><dd className="tnum text-ink-50">#{r.reportId}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-ink-300">發布時間</dt><dd className="text-ink-200">{new Date(r.publishedAt * 1000).toLocaleString("zh-TW")}</dd></div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-300">查核簽署</dt>
                  <dd className={st?.cls}>{r.attestedAt ? `${st?.label}　${new Date(r.attestedAt * 1000).toLocaleDateString("zh-TW")}` : "尚未簽署"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-300">報告全文雜湊</dt><dd className="font-mono text-xs text-ink-300">{short(r.documentHash)}</dd>
                </div>
              </dl>
              <p className="mt-3 border-t border-ink-500 pt-3 text-xs leading-6 text-ink-300">
                已揭露期別：{c.periods.length === 0 ? "—" : c.periods.map(period).join("、")}。
                報告一經查核機構簽署即不可修改；更正會以新的報告發布，舊的仍留在鏈上可查。
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
