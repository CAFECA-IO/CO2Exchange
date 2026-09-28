"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, Notice } from "@/components/ui";
import { fetchJson } from "@/lib/client/fetchJson";

/// 審計（技術揭露與審計資訊）：這一頁把「鏈上有什麼、鏈下有什麼、哪些保證變弱了、要怎麼自己驗」講完。
///
/// 設計 v4 把登錄簿、身分與市場搬到鏈下帳本，鏈上只留每小時的承諾、授權金鑰清單與結算幣託管。
/// 這換來了不必等出塊、不付 gas 的交易，代價是**有些規則從「合約拒絕」降級成「重播抓得到」**。
/// 那個降級要寫在使用者看得到的地方，不能只寫在設計文件裡——所以有這一頁。
///
/// 不需要登入：驗證的意義就在於不必是本站的使用者也能做。

type Epoch = {
  epoch: string; anchor: string; txHash: string; blockNumber: string;
  firstSeq: string; lastSeq: string; totalKg: string; totalCash: string;
};
type Config = { deployment: { chainId: number; ledger: string; settlementToken: string; nationalSafe: string; operatorSafe: string; timelock: string; deployedAtBlock?: number } };

const short = (h: string) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");
const tonnes = (kg: string) => (Number(kg) / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 1 });
const twd = (v: string) => (Number(v) / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 0 });

function Row({ k, v, mono = true }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 py-1.5">
      <dt className="text-ink-300">{k}</dt>
      <dd className={`${mono ? "font-mono text-xs" : ""} break-all text-ink-100`}>{v}</dd>
    </div>
  );
}

export default function AuditPage() {
  const [epochs, setEpochs] = useState<Epoch[] | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    Promise.all([fetchJson<{ epochs: Epoch[] }>("/api/public/epochs"), fetchJson<Config>("/api/config")])
      .then(([e, c]) => { if (!ignore) { setEpochs(e.epochs); setCfg(c); } })
      .catch((e) => { if (!ignore) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { ignore = true; };
  }, []);

  const d = cfg?.deployment;
  const recent = epochs ? [...epochs].reverse().slice(0, 24) : [];

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-tide">審計</p>
        <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-ink-50">技術揭露與審計資訊</h1>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-ink-200">
          本站的交易、登錄簿與身分都記在一份鏈下帳本裡，每小時把整份帳本壓成一期承諾寫上區塊鏈。
          這一頁說明鏈上有什麼、哪些保證因此變弱了，以及任何人不必相信本站、自己驗證的方法。
        </p>
      </div>

      {err && <Notice kind="error">{err}</Notice>}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="鏈上有什麼">
          <ul className="space-y-2 text-sm leading-6 text-ink-200">
            <li><b className="text-ink-50">每小時一期承諾。</b>事件 log root、帶總額的餘額樹 root、登錄簿 root、身分 root、逐批次總量表的雜湊、算到哪一筆事件與哪一個區塊，並與前一期串連。事後改不掉。</li>
            <li><b className="text-ink-50">授權金鑰清單與門檻。</b>誰能簽核發、身分、凍結、費率、對帳報告。由國家單位的多簽（Safe）管理；帳本裡每一筆授權事件都要由收單當時有效的金鑰簽署。</li>
            <li><b className="text-ink-50">結算幣託管。</b>存入轉進帳本合約；合約拒絕任何一期宣稱欠使用者的結算幣多於它實際持有的承諾。</li>
            <li><b className="text-ink-50">提領與逃生門。</b>憑最新一期的證據領回結算幣；超過 72 小時沒有新承諾，任何人都能憑最後一期的證據領回全部欠款，沒有任何角色關得掉。</li>
          </ul>
        </Card>
        <Card title="鏈下有什麼">
          <ul className="space-y-2 text-sm leading-6 text-ink-200">
            <li><b className="text-ink-50">帳本本身。</b>每一筆事件（委託單、撤單、註銷、核發、身分、費率、存提）照順序接成雜湊鏈，每一筆都帶簽章。</li>
            <li><b className="text-ink-50">碳權。</b>額度託管在核發國官方登錄簿（國內額度在專案方的額度帳戶，國外額度在本站的託管帳戶）。帳本記的是對那些額度的請求權。</li>
            <li><b className="text-ink-50">撮合。</b>成交、持有與憑證是重播帳本的結果，不另外記錄——記了結果就有兩份真相。</li>
          </ul>
        </Card>
      </div>

      <Card title="保證的降級：哪些規則不再由合約擋下">
        <div className="space-y-3 text-sm leading-7 text-ink-200">
          <p>
            以前由合約在交易當下拒絕的規則，現在由帳本引擎執行：身分與效期、自然人不得註銷、轄區是否開放、
            國外額度的用途限制、凍結、手續費、撮合的價格與數量。這些規則<b className="text-ink-50">仍然會執行</b>，
            但保證的性質變了——從「合約拒絕」變成「<b className="text-ink-50">重播抓得到</b>」：
            營運方如果收下一筆違規的事件，它不會被鏈上擋下來，而是任何重播帳本的人都會在同一個位置看到不一致，
            算出的承諾也對不上鏈上那一期。
          </p>
          <p>具體來說，營運方<b className="text-ink-50">做得到、但藏不住</b>的事：</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>收下一筆違反規則的事件——重播時會被引擎拒絕，但事件仍在帳本裡、且每小時上鏈。</li>
            <li>決定同一時間到達的委託單的先後——序號由營運方給，但序號與內容都進雜湊鏈，事後改不了。</li>
            <li>拒收您的委託單或提領請求（不給簽收收據）——您手上沒有收據就代表那筆沒有進帳本。
              <b className="text-ink-50">這是目前設計的缺口：</b>營運方若持續提交承諾、卻只拒收您一人的提領請求，逃生門不會開啟
              （它只在全站停擺 72 小時後開啟）。您簽過的請求與沒有收據這件事，是向主管機關申訴的依據；
              鏈上強制收單的機制列在後續工作。</li>
            <li>不公布帳本——所以帳本鏡像同時交付查核機構與主管機關，您也可以隨時下載自己的證據檔。</li>
          </ul>
          <p>營運方<b className="text-ink-50">做不到</b>的事：替您簽委託單（沒有您的 EIP-712 簽章，帳本不收）、竄改已上鏈的任何一期、
            宣稱欠的結算幣多於合約持有的、阻止逃生提領、自己核發額度（核發要查驗機構的金鑰）。</p>
        </div>
      </Card>

      <Card title="分層公開：誰看得到什麼">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-300">
              <tr><th className="py-1.5 pr-3">層</th><th className="pr-3">內容</th><th>誰看得到</th></tr>
            </thead>
            <tbody className="divide-y divide-ink-600 text-ink-200">
              <tr><td className="py-2 pr-3 align-top text-ink-50">鏈上</td><td className="pr-3">每一期的承諾（只有雜湊與總額）</td><td className="align-top">任何人</td></tr>
              <tr><td className="py-2 pr-3 align-top text-ink-50">公開檔</td><td className="pr-3">每一筆事件的雜湊；轄區、政策、費率、專案、核發、註銷、憑證、對帳報告、批次凍結的全文；登錄簿葉子與逐批次總量表</td><td className="align-top">任何人（本頁下方）</td></tr>
              <tr><td className="py-2 pr-3 align-top text-ink-50">只公開雜湊</td><td className="pr-3">委託單、身分、存提、提領請求、金鑰鏡像、帳戶凍結</td><td className="align-top">全文只在監理鏡像與當事人自己的證據檔</td></tr>
              <tr><td className="py-2 pr-3 align-top text-ink-50">監理鏡像</td><td className="pr-3">完整帳本（全部事件全文）、部署檔、SHA-256 清單</td><td className="align-top">查核機構、主管機關</td></tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs leading-6 text-ink-300">
          帳本裡沒有姓名、身分證字號或聯絡方式：身分事件只記帳戶地址、等級、效期與身分雜湊（加鹽後的雜湊，不可逆推）。
          詳見<Link className="text-tide underline" href="/agreements/privacy-policy">隱私權政策</Link>。
        </p>
      </Card>

      <Card title="自己驗證">
        <ol className="space-y-3 text-sm leading-7 text-ink-200">
          <li>
            <b className="text-ink-50">① 驗我自己的持有。</b>到<Link className="text-tide underline" href="/trade">交易</Link>頁下載「我的證明檔」，
            用任何一個節點執行：
            <pre className="mt-1 overflow-x-auto rounded bg-ink-800 p-2 text-xs text-ink-100">node web/scripts/verify-proof.mjs 證明檔.json --rpc &lt;任一節點&gt;</pre>
            驗證器只用 viem，不引用本站任何程式碼；它自己回鏈上取那一期的承諾，不相信證明檔裡寫的 root。
          </li>
          <li>
            <b className="text-ink-50">② 驗某一期的公開內容。</b>下載下方任一期的公開檔，依
            <a className="text-tide underline" href="https://github.com/CAFECA-IO/CO2Exchange/blob/main/docs/proof-schemes.md" target="_blank" rel="noreferrer">雜湊規則</a>
            重建 logRoot 與 registryRoot，對照鏈上的 <code>Committed</code> 事件。
          </li>
          <li>
            <b className="text-ink-50">③ 重播整份帳本（查核機構、主管機關）。</b>用監理鏡像：
            <pre className="mt-1 overflow-x-auto rounded bg-ink-800 p-2 text-xs text-ink-100">LEDGER_DIR=&lt;鏡像&gt;/ledger DEPLOYMENT_FILE=&lt;鏡像&gt;/deployment.json RPC_URL=&lt;任一節點&gt; npm run ledger:verify</pre>
            在收單當時的區塊高度重驗每一筆簽章、逐筆對照鏈上的存提，算出的每一期 anchor 必須等於鏈上那一個，否則 exit 1。
          </li>
        </ol>
      </Card>

      {d && (
        <Card title="合約">
          <dl className="divide-y divide-ink-600 text-sm">
            <Row k="鏈" v={String(d.chainId)} />
            <Row k="帳本合約" v={d.ledger} />
            <Row k="結算幣" v={d.settlementToken} />
            <Row k="國家單位 Safe（授權清單）" v={d.nationalSafe} />
            <Row k="營運 Safe（提領開關、承諾提交者）" v={d.operatorSafe} />
            <Row k="Timelock（角色更換，48 小時）" v={d.timelock} />
            {d.deployedAtBlock !== undefined && <Row k="部署區塊" v={String(d.deployedAtBlock)} />}
          </dl>
        </Card>
      )}

      <Card title={`已上鏈的承諾${epochs ? `（共 ${epochs.length} 期，列出最近 ${recent.length} 期）` : ""}`}>
        {!epochs ? <p className="text-sm text-ink-300">讀取中…</p> : epochs.length === 0 ? (
          <p className="text-sm text-ink-300">還沒有任何一期承諾上鏈。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-300">
                <tr>
                  <th className="py-1.5 pr-3">期</th><th className="pr-3">事件</th><th className="pr-3 text-right">碳權（噸）</th>
                  <th className="pr-3 text-right">結算幣（元）</th><th className="pr-3">anchor</th><th className="pr-3">交易</th><th>公開檔</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-600">
                {recent.map((e) => (
                  <tr key={e.epoch}>
                    <td className="tnum py-1.5 pr-3 text-ink-50">{e.epoch}</td>
                    <td className="tnum pr-3 text-ink-200">{e.firstSeq}–{e.lastSeq}</td>
                    <td className="tnum pr-3 text-right text-ink-200">{tonnes(e.totalKg)}</td>
                    <td className="tnum pr-3 text-right text-ink-200">{twd(e.totalCash)}</td>
                    <td className="pr-3 font-mono text-xs text-ink-300">{short(e.anchor)}</td>
                    <td className="pr-3 font-mono text-xs text-ink-300" title={`區塊 ${e.blockNumber}`}>{short(e.txHash)}</td>
                    <td><a className="text-tide underline" href={`/api/public/epochs/${e.epoch}`} target="_blank" rel="noreferrer">JSON</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs leading-6 text-ink-300">
        償付能力（帳本宣稱欠多少 vs 實際有多少）與國家級託管的對帳報告在<Link className="text-tide underline" href="/custody">託管揭露</Link>；
        每一筆核發、移轉、註銷在<Link className="text-tide underline" href="/registry">公告欄</Link>。
      </p>
    </div>
  );
}
