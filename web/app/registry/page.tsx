"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Notice, fmtKg, fmtTwd } from "@/components/ui";
import { useReload } from "@/lib/client/useReload";
import { flagOf } from "@/lib/deployment";
import type { Announcement, Bulletin } from "@/lib/server/bulletin";
import { fetchJson } from "@/lib/client/fetchJson";

/// 公開資訊（公告欄）。
///
/// 分頁沿用環境部 TCER 登錄系統公開資訊的五塊：額度總覽、核發資訊、移轉紀錄、
/// 使用及註銷、參與事業。差別在資料來源——這裡每一列都直接對應一筆鏈上事件，
/// 點得進交易雜湊，不是人工上傳的表格。
///
/// 這頁不需要登入。公告的意義就在於任何人都看得到。

const TABS = ["額度總覽", "核發資訊", "移轉紀錄", "使用及註銷", "參與事業"] as const;
type Tab = (typeof TABS)[number];

const fmtTime = (t: number) => new Date(t * 1000).toLocaleString("zh-TW", { dateStyle: "short", timeStyle: "short" });
const fmtDate = (t: number) => new Date(t * 1000).toLocaleDateString("zh-TW");
const addr = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

const KIND_LABEL: Record<Announcement["kind"], string> = {
  issue: "核發",
  list: "上架",
  transfer: "移轉",
  retire: "註銷",
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4">
      <div className="text-[11px] uppercase tracking-wider text-ink-300">{label}</div>
      <div className="tnum mt-1 font-display text-xl font-semibold text-ink-50">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-300">{sub}</div>}
    </div>
  );
}

function Tx({ hash }: { hash: string }) {
  return <span className="tnum font-mono text-xs text-ink-300" title={hash}>{hash.slice(0, 10)}…</span>;
}

export default function RegistryPage() {
  const [b, setB] = useState<Bulletin | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("額度總覽");
  const [reloadKey] = useReload();

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const j = await fetchJson<Bulletin>("/api/bulletin");
        if (!ignore) { setB(j); setErr(null); }
      } catch (e) {
        if (!ignore) setErr(e instanceof Error ? e.message : "讀取失敗");
      }
    })();
    return () => { ignore = true; };
  }, [reloadKey]);

  const rows = (kind: Announcement["kind"]) => b?.announcements.filter((a) => a.kind === kind) ?? [];

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-tide">公開資訊</p>
        <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-ink-50">額度公告欄</h1>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-ink-200">
          本站每一筆額度的核發、上架、移轉與註銷都在此公告，任何人不必登入都看得到。
          每一列都對應一筆鏈上交易，可自行以交易雜湊查驗，不是人工整理的表格。
          欄位分類比照環境部
          <a className="text-tide underline" href="https://tcerregistry.moenv.gov.tw/public-info" target="_blank" rel="noreferrer">
            溫室氣體減量額度管理系統
          </a>
          的公開資訊。
        </p>
      </div>

      {err && <Notice kind="error">{err}</Notice>}
      {!b ? <p className="text-sm text-ink-300">讀取中…</p> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="累計核發" value={fmtKg(b.summary.issuedKg)} sub={`${b.summary.projects} 個專案`} />
            <Stat label="流通中" value={fmtKg(b.summary.circulatingKg)} sub="已核發扣除已註銷" />
            <Stat label="累計註銷" value={fmtKg(b.summary.retiredKg)} sub="永久退出流通" />
            <Stat label="累計移轉" value={fmtKg(b.summary.transferredKg)} sub={`${b.summary.participants} 個參與帳戶`} />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-[--radius-ctl] px-3 py-1.5 text-sm transition ${
                  tab === t ? "bg-tide font-medium text-ink-900" : "border border-ink-500 text-ink-300 hover:text-ink-50"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === "額度總覽" && (
            <Card title="最新公告">
              {b.announcements.length === 0 ? <p className="text-sm text-ink-300">尚無公告。</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wider text-ink-300">
                      <tr className="border-b border-ink-500">
                        <th className="py-2 pr-3 font-medium">公告編號</th>
                        <th className="py-2 pr-3 font-medium">類別</th>
                        <th className="py-2 pr-3 font-medium">轄區</th>
                        <th className="py-2 pr-3 font-medium">公告時間</th>
                        <th className="py-2 pr-3 font-medium">批次</th>
                        <th className="py-2 pr-3 text-right font-medium">數量</th>
                        <th className="py-2 font-medium">交易</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-500">
                      {b.announcements.slice(0, 50).map((a) => (
                        <tr key={a.no} className="text-ink-200">
                          <td className="tnum py-2 pr-3 font-mono text-xs">{a.no}</td>
                          <td className="py-2 pr-3">{KIND_LABEL[a.kind]}</td>
                          <td className="py-2 pr-3 whitespace-nowrap">{a.country ? `${flagOf(a.country)} ${a.country}` : "—"}</td>
                          <td className="py-2 pr-3 whitespace-nowrap text-ink-300">{fmtTime(a.ts)}</td>
                          <td className="tnum py-2 pr-3">#{a.batchId ?? "—"}</td>
                          <td className="tnum py-2 pr-3 text-right">{fmtKg(a.amountKg)}</td>
                          <td className="py-2"><Tx hash={a.txHash} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          {tab === "核發資訊" && (
            <Card title={`核發紀錄（${rows("issue").length}）`}>
              <div className="space-y-3">
                {rows("issue").map((a) => (
                  <div key={a.no} className="rounded-[--radius-card] border border-ink-500 bg-ink-800 p-3 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="tnum font-mono text-xs text-tide">{a.no}</span>
                      <span className="text-xs text-ink-300">{fmtTime(a.ts)}</span>
                    </div>
                    <div className="mt-2 grid gap-1 sm:grid-cols-2">
                      <div><span className="text-ink-300">專案 / 批次：</span>#{a.projectId} / #{a.batchId}</div>
                      <div><span className="text-ink-300">核發數量：</span><b className="tnum">{fmtKg(a.amountKg)}</b></div>
                      <div className="sm:col-span-2">
                        <span className="text-ink-300">額度編碼（本站格式）：</span>
                        <span className="tnum font-mono text-xs break-all">{a.serial}</span>
                      </div>
                      <div><span className="text-ink-300">受配帳戶：</span><span className="font-mono text-xs">{addr(a.to)}</span></div>
                      <div><span className="text-ink-300">交易：</span><Tx hash={a.txHash} /></div>
                    </div>
                  </div>
                ))}
                {rows("issue").length === 0 && <p className="text-sm text-ink-300">尚無核發紀錄。</p>}
              </div>
            </Card>
          )}

          {tab === "移轉紀錄" && (
            <Card title={`移轉紀錄（${rows("transfer").length}）`}>
              <p className="mb-3 text-xs leading-6 text-ink-300">
                此處的移轉為本站鏈上請求權的移轉，不動官方登錄簿。依溫室氣體減量額度交易拍賣及移轉管理辦法第 26 條，
                每一額度單位在官方登錄簿的移轉以一次為限；該次移轉於最終買方申請註銷時，自專案方帳戶直接移轉至買方帳戶。
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-ink-300">
                    <tr className="border-b border-ink-500">
                      <th className="py-2 pr-3 font-medium">公告編號</th>
                      <th className="py-2 pr-3 font-medium">時間</th>
                      <th className="py-2 pr-3 font-medium">批次</th>
                      <th className="py-2 pr-3 font-medium">移出</th>
                      <th className="py-2 pr-3 font-medium">移入</th>
                      <th className="py-2 pr-3 text-right font-medium">數量</th>
                      <th className="py-2 pr-3 text-right font-medium">單價 / 噸</th>
                      <th className="py-2 font-medium">交易</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-500">
                    {rows("transfer").map((a) => (
                      <tr key={a.no} className="text-ink-200">
                        <td className="tnum py-2 pr-3 font-mono text-xs">{a.no}</td>
                        <td className="py-2 pr-3 whitespace-nowrap text-ink-300">{fmtTime(a.ts)}</td>
                        <td className="tnum py-2 pr-3">#{a.batchId ?? "—"}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{addr(a.from)}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{addr(a.to)}</td>
                        <td className="tnum py-2 pr-3 text-right">{fmtKg(a.amountKg)}</td>
                        <td className="tnum py-2 pr-3 text-right">{a.pricePerTonne ? fmtTwd(BigInt(Math.round(a.pricePerTonne))) : "—"}</td>
                        <td className="py-2"><Tx hash={a.txHash} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows("transfer").length === 0 && <p className="text-sm text-ink-300">尚無移轉紀錄。</p>}
              </div>
            </Card>
          )}

          {tab === "使用及註銷" && (
            <Card title={`註銷紀錄（${rows("retire").length}）`}>
              <p className="mb-3 text-xs leading-6 text-ink-300">
                依同辦法第 27 條，中央主管機關於註銷次日起五個工作日內公開註銷用途，
                事業須待公開後始得對外進行環境聲明或宣告。下表的「可對外宣告日」為公告日加五個工作日，
                僅計週六日，未扣除國定假日，實際日期以主管機關公開時間為準。
              </p>
              <div className="space-y-3">
                {rows("retire").map((a) => (
                  <div key={a.no} className="rounded-[--radius-card] border border-ink-500 bg-ink-800 p-3 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="tnum font-mono text-xs text-tide">{a.no}</span>
                      <span className="text-xs text-ink-300">{fmtTime(a.ts)}</span>
                    </div>
                    <div className="mt-2 grid gap-1 sm:grid-cols-2">
                      <div><span className="text-ink-300">批次 / 憑證：</span>#{a.batchId} / 憑證 #{a.certId}</div>
                      <div><span className="text-ink-300">註銷數量：</span><b className="tnum">{fmtKg(a.amountKg)}</b></div>
                      <div><span className="text-ink-300">註銷人：</span><span className="font-mono text-xs">{addr(a.from)}</span></div>
                      <div><span className="text-ink-300">憑證所有人：</span><span className="font-mono text-xs">{addr(a.to)}</span></div>
                      <div className="sm:col-span-2">
                        <span className="text-ink-300">可對外宣告日（不早於）：</span>
                        <b className="tnum">{a.claimableFrom ? fmtDate(a.claimableFrom) : "—"}</b>
                      </div>
                      <div><span className="text-ink-300">交易：</span><Tx hash={a.txHash} /></div>
                    </div>
                  </div>
                ))}
                {rows("retire").length === 0 && <p className="text-sm text-ink-300">尚無註銷紀錄。</p>}
              </div>
            </Card>
          )}

          {tab === "參與事業" && (
            <Card title={`參與帳戶（${b.participants.length}）`}>
              <p className="mb-3 text-xs text-ink-300">僅揭露鏈上地址與彙總數量，不揭露身分資料。</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-ink-300">
                    <tr className="border-b border-ink-500">
                      <th className="py-2 pr-3 font-medium">帳戶</th>
                      <th className="py-2 pr-3 text-right font-medium">受配</th>
                      <th className="py-2 pr-3 text-right font-medium">賣出</th>
                      <th className="py-2 pr-3 text-right font-medium">買入</th>
                      <th className="py-2 text-right font-medium">註銷</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-500">
                    {b.participants.map((p) => (
                      <tr key={p.address} className="text-ink-200">
                        <td className="py-2 pr-3 font-mono text-xs">{addr(p.address)}</td>
                        <td className="tnum py-2 pr-3 text-right">{fmtKg(p.issued)}</td>
                        <td className="tnum py-2 pr-3 text-right">{fmtKg(p.sold)}</td>
                        <td className="tnum py-2 pr-3 text-right">{fmtKg(p.bought)}</td>
                        <td className="tnum py-2 text-right">{fmtKg(p.retired)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      <p className="text-xs leading-6 text-ink-300">
        本站額度全程登錄在專案方自己於環境部開立的額度帳戶內，平台不持有任何額度；鏈上移轉的是對該批額度的請求權，
        不觸發也不消耗官方移轉次數。那唯一一次官方移轉發生在最終買方（具額度帳戶之事業）申請註銷時。
        官方登錄簿的紀錄以
        <a className="text-tide underline" href="https://tcerregistry.moenv.gov.tw/" target="_blank" rel="noreferrer">環境部系統</a>
        為準。契約條款見<Link className="text-tide underline" href="/agreements">定型化契約</Link>。
      </p>
    </div>
  );
}
