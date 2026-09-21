import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui";
import { Markdown } from "@/components/Markdown";
import { agreement, agreementMetas } from "@/lib/server/agreements";

/// 一份文件一個網址。
///
/// 法律文件會被引用、被存證、被貼進 email 與函文裡；那個連結必須點開就是那一份。
/// 每一份也因此有自己的 <title> 與 description——分享到通訊軟體時，預覽卡上
/// 出現的是文件名稱，而不是七份共用的一個標題。

export async function generateStaticParams() {
  return agreementMetas().map((m) => ({ id: m.id }));
}

export async function generateMetadata(props: PageProps<"/agreements/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const a = agreement(id);
  if (!a) return { title: "找不到這份文件" };
  return {
    title: `${a.title} ${a.version}`,
    description: a.summary.slice(0, 200),
  };
}

function stripTitle(body: string, title: string): string {
  const m = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/.exec(body);
  return m && m[1] === title ? body.slice(m[0].length) : body;
}

export default async function AgreementPage(props: PageProps<"/agreements/[id]">) {
  const { id } = await props.params;
  const doc = agreement(id);
  if (!doc) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link href="/agreements" className="text-xs text-tide underline underline-offset-4 hover:text-ink-50">
          ← 所有契約與條款
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink-50">{doc.title}</h1>
          <span className="tnum rounded bg-ink-600 px-1.5 py-0.5 text-xs text-ink-300">{doc.version}</span>
        </div>
        <p className="mt-1 text-xs text-ink-300">適用：{doc.parties}．生效日 {doc.effectiveDate}</p>
      </div>

      <Card>
        <div className="space-y-2 text-sm leading-7 text-ink-200">
          {/*
            條文檔第一行是 `# <文件名稱>`，而頁面標題已經是同一句。兩個一起畫，
            畫面上會連續出現兩次同樣的字。在這裡拿掉，而不是從 markdown 刪——
            那份檔案是要能單獨拿去看、拿去存證的，標題必須留在檔案裡。
          */}
          <Markdown>{stripTitle(doc.body, doc.title)}</Markdown>
        </div>
        <p className="tnum mt-6 border-t border-ink-500 pt-3 font-mono text-[11px] break-all text-ink-300">
          內容雜湊 keccak256：{doc.hash}
        </p>
      </Card>
    </div>
  );
}
