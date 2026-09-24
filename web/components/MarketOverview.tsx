"use client";
import { useEffect, useState } from "react";
import { AreaChart, BarList, Donut, StatTile } from "./charts";
import { Card } from "./ui";
import type { Bulletin } from "@/lib/server/bulletin";
import { fetchJson } from "@/lib/client/fetchJson";

/// 首頁的市場概況。
///
/// 上面的 MarketPanel 回答「現在多少錢」，這一段回答「這個市場有多大、額度去了哪裡」。
/// 四個數字磚是一眼就要看懂的：核發多少、還在流通多少、已經用掉多少、有多少家在參與。
/// 下面三張圖各回答一個後續問題——比例、現在買得到什麼、累積下來多少量。
///
/// 全部由鏈上事件推導（/api/bulletin 與 /api/market），沒有任何模擬數字。

type Order = { batchId: number; remainingKg: number; pricePerTonne: string; project: { name: string; methodology: string } };

const tonnes = (kg: number) => kg / 1000;
const fmtT = (kg: number) => `${tonnes(kg).toLocaleString("zh-TW", { maximumFractionDigits: 1 })} 噸`;

export function MarketOverview() {
  const [b, setB] = useState<Bulletin | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [bj, mj] = await Promise.all([
          fetchJson<Bulletin>("/api/bulletin"),
          fetchJson<{ orders: Order[] }>("/api/market"),
        ]);
        if (!live) return;
        // 失敗現在是丟例外，不是回一個帶 error 欄位的物件——所以這裡拿到的一定是成功的資料。
        setB(bj);
        setOrders(mj.orders ?? []);
      } catch { /* 首頁的補充資訊，讀不到就不顯示，不要擋住主要內容 */ }
    })();
    return () => { live = false; };
  }, []);

  if (!b) return null;
  const s = b.summary;

  // 掛單簿依專案彙總：使用者想知道「現在買得到什麼」，而不是有幾筆掛單
  const byProject = new Map<string, { kg: number; best: number }>();
  for (const o of orders ?? []) {
    const cur = byProject.get(o.project.name) ?? { kg: 0, best: Infinity };
    cur.kg += o.remainingKg;
    cur.best = Math.min(cur.best, Number(o.pricePerTonne));
    byProject.set(o.project.name, cur);
  }
  const supply = [...byProject.entries()]
    .map(([name, v]) => ({ label: name, value: tonnes(v.kg), hint: `最佳價 ${(v.best / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 0 })} mTWD / 噸` }))
    .sort((a, x) => x.value - a.value)
    .slice(0, 6);

  // 累計成交量：把每一筆移轉公告加起來，看的是市場有沒有在長大
  const transfers = b.announcements.filter((a) => a.kind === "transfer").sort((a, x) => a.ts - x.ts);
  const cumulative = transfers.reduce<{ t: number; v: number }[]>((out, tr) => {
    out.push({ t: tr.ts, v: (out.at(-1)?.v ?? 0) + tonnes(tr.amountKg) });
    return out;
  }, []);

  return (
    <section className="space-y-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-tide">市場概況</p>
        <h2 className="mt-1 font-display text-xl font-semibold tracking-tight text-ink-50">這個市場現在有多大</h2>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="累計核發" value={fmtT(s.issuedKg)} sub={`${s.projects} 個已核發專案`} />
        <StatTile label="流通中" value={fmtT(s.circulatingKg)} sub="尚未註銷、可再交易" />
        <StatTile label="已註銷" value={fmtT(s.retiredKg)} sub="永久退出流通" />
        <StatTile label="參與事業" value={`${s.participants}`} sub={`累計移轉 ${fmtT(s.transferredKg)}`} />
      </div>

      {/* `minmax(0,…)` 而不是 `1fr`：grid 項目的最小寬度預設是內容寬度，
          所以一張內容很寬的卡片會把整條軌道（連同整個頁面）撐開。 */}
      {/* `grid-cols-1` 看起來多餘（單欄本來就是預設），但它換掉的是**軌道的最小尺寸**：
          隱含軌道是 `auto`，會被最寬的那張卡撐開；Tailwind 的 grid-cols-1 是
          `minmax(0,1fr)`，肯縮。少了這一個類別，手機上整頁可以左右拖動。 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card title="額度去了哪裡">
          <Donut
            slices={[
              { label: "流通中", value: tonnes(s.circulatingKg), hint: fmtT(s.circulatingKg) },
              { label: "已註銷", value: tonnes(s.retiredKg), hint: fmtT(s.retiredKg) },
            ]}
            centerLabel="累計核發（噸）"
            centerValue={tonnes(s.issuedKg).toLocaleString("zh-TW", { maximumFractionDigits: 0 })}
          />
          <p className="mt-4 border-t border-ink-500 pt-3 text-xs leading-6 text-ink-300">
            註銷代表那一公噸被某家事業用掉了，永遠不會再出現在市場上。
            註銷比例愈高，表示額度真的被拿去抵減排放，而不是在市場上轉來轉去。
          </p>
        </Card>

        <Card title="現在買得到什麼" action={<span className="text-xs text-ink-300">掛單簿依專案彙總</span>}>
          <BarList unit=" 噸" rows={supply} />
          {supply.length > 0 && (
            <p className="mt-3 text-xs leading-6 text-ink-300">
              每一筆都是實際掛在鏈上的賣單，點進<a className="text-tide underline" href="/trade">交易</a>就能直接成交。
            </p>
          )}
        </Card>
      </div>

      {cumulative.length > 1 && (
        <Card title="累計成交量">
          <p className="mb-2 text-xs text-ink-300">每一筆成交累加。看的是市場有沒有在長大，而不是單日的起伏。</p>
          <AreaChart points={cumulative} label="噸" format={(v) => v.toLocaleString("zh-TW", { maximumFractionDigits: 1 })} />
        </Card>
      )}
    </section>
  );
}
