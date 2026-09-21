/// 極簡 markdown：契約與條款只用到標題、粗體、行內碼、清單、分隔線與表格，
/// 為了這幾份靜態文件拉一套 markdown 套件不划算。
///
/// 純函式、沒有 hook，所以 server component 直接用得上——條文因此是伺服器端
/// 就渲染好的 HTML，關掉 JavaScript 也讀得到，搜尋引擎與「另存新檔」也拿得到全文。
/// 一份法律文件應該要有這個性質。

export function Markdown({ children }: { children: string }) {
  return <>{render(children)}</>;
}

export function render(md: string) {
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
            {body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="py-2 pr-3 align-top">{inline(c, `t${i}${j}`)}</td>)}</tr>)}
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
