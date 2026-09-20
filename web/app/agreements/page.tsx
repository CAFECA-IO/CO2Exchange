"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, Notice } from "@/components/ui";

/// 定型化契約專區（公開，不需登入）。
///
/// 四份文件都放在版控的 markdown 裡，雜湊由檔案內容算出。介面顯示雜湊，
/// 是為了讓使用者事後能證明「我當時同意的是哪一版」——條文改一個字，雜湊就不一樣。

type Meta = { id: string; title: string; version: string; effectiveDate: string; summary: string; hash: string; parties: string };
type Doc = Meta & { body: string };

/// 極簡 markdown：這些條文只用到標題、粗體、清單、分隔線與表格，
/// 為了四份靜態文件拉一套 markdown 套件不划算。
function render(md: string) {
  const lines = md.split(/\r?\n/);
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  let table: string[][] = [];

  const inline = (s: string, key: string) => {
    const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
    return parts.map((p, i) =>
      p.startsWith("**") ? <b key={`${key}-${i}`} className="text-ink-50">{p.slice(2, -2)}</b>
      : p.startsWith("`") ? <code key={`${key}-${i}`} className="rounded bg-ink-600 px-1 text-xs">{p.slice(1, -1)}</code>
      : <span key={`${key}-${i}`}>{p}</span>,
    );
  };
  const flushList = (key: string) => {
    if (!list.length) return;
    out.push(<ul key={key} className="ml-5 list-disc space-y-1">{list.map((li, i) => <li key={i}>{inline(li, `${key}-${i}`)}</li>)}</ul>);
    list = [];
  };
  const flushTable = (key: string) => {
    if (!table.length) return;
    const [head, ...body] = table.filter((r) => !r.every((c) => /^-+$/.test(c.trim())));
    out.push(
      <div key={key} className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-ink-300">
            <tr className="border-b border-ink-500">{head.map((c, i) => <th key={i} className="py-2 pr-3 font-medium">{c}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-ink-500">
            {body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="py-2 pr-3">{inline(c, `t${i}${j}`)}</td>)}</tr>)}
          </tbody>
        </table>
      </div>,
    );
    table = [];
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const key = `l${i}`;
    if (/^\s*\|/.test(line)) { table.push(line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim())); return; }
    flushTable(`tb${i}`);
    if (/^\s*[-*]\s+/.test(line)) { list.push(line.replace(/^\s*[-*]\s+/, "")); return; }
    flushList(`ul${i}`);
    if (!line.trim()) return;
    if (line.startsWith("### ")) out.push(<h3 key={key} className="pt-3 font-display text-base font-semibold text-ink-50">{line.slice(4)}</h3>);
    else if (line.startsWith("## ")) out.push(<h2 key={key} className="pt-4 font-display text-lg font-semibold text-ink-50">{line.slice(3)}</h2>);
    else if (line.startsWith("# ")) out.push(<h1 key={key} className="font-display text-xl font-bold text-ink-50">{line.slice(2)}</h1>);
    else if (/^---+$/.test(line.trim())) out.push(<hr key={key} className="border-ink-500" />);
    else out.push(<p key={key}>{inline(line, key)}</p>);
  });
  flushList("ul-end");
  flushTable("tb-end");
  return out;
}

/// useSearchParams 會讓這頁變成需要 request 才能渲染；靜態預渲染時必須有 Suspense 邊界，
/// 否則 next build 直接失敗。外層包一層，內容照舊。
export default function AgreementsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-300">讀取中…</p>}>
      <AgreementsInner />
    </Suspense>
  );
}

function AgreementsInner() {
  const params = useSearchParams();
  const wanted = params.get("id");
  const [metas, setMetas] = useState<Meta[]>([]);
  // doc 連同它屬於哪個 id 一起存，換文件時不必在 effect 裡先清空
  const [loaded, setLoaded] = useState<Doc | null>(null);
  const doc = loaded && loaded.id === wanted ? loaded : null;
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      const r = await fetch("/api/agreements");
      const j = await r.json();
      if (!ignore) { if (r.ok) setMetas(j.agreements ?? []); else setErr(j.error ?? "讀取失敗"); }
    })();
    return () => { ignore = true; };
  }, []);

  useEffect(() => {
    if (!wanted) return;
    let ignore = false;
    (async () => {
      const r = await fetch(`/api/agreements?id=${wanted}`);
      const j = await r.json();
      if (!ignore) { if (r.ok) setLoaded(j); else setErr(j.error ?? "讀取失敗"); }
    })();
    return () => { ignore = true; };
  }, [wanted]);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-tide">契約條款</p>
        <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-ink-50">定型化契約</h1>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-ink-200">
          買賣雙方在本站的權利義務由下列四份契約界定。每一份都標示版本與內容雜湊；
          您在操作時同意的是「當下那一版的雜湊」，條文改版後會再次請您確認，舊的同意不會被沿用。
        </p>
      </div>

      {err && <Notice kind="error">{err}</Notice>}

      <div className="grid gap-3 md:grid-cols-2">
        {metas.map((m) => (
          <a
            key={m.id}
            href={`/agreements?id=${m.id}`}
            className={`rounded-[--radius-card] border p-4 transition ${
              wanted === m.id ? "border-tide/70 bg-tide/10" : "border-ink-500 bg-ink-700 hover:border-tide/60"
            }`}
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="font-display text-base font-semibold text-ink-50">{m.title}</h2>
              <span className="tnum rounded bg-ink-600 px-1.5 py-0.5 text-[11px] text-ink-300">{m.version}</span>
            </div>
            <p className="mt-1 text-xs text-ink-300">適用：{m.parties}．生效日 {m.effectiveDate}</p>
            <p className="mt-2 text-sm leading-6 text-ink-200">{m.summary}</p>
            <p className="tnum mt-2 font-mono text-[11px] break-all text-ink-300">{m.hash}</p>
          </a>
        ))}
      </div>

      {doc && (
        <Card title={`${doc.title}　${doc.version}`}>
          <div className="space-y-2 text-sm leading-7 text-ink-200">{render(doc.body)}</div>
          <p className="tnum mt-6 border-t border-ink-500 pt-3 font-mono text-[11px] break-all text-ink-300">
            內容雜湊 keccak256：{doc.hash}
          </p>
        </Card>
      )}
    </div>
  );
}
