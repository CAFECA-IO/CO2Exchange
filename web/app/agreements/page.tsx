import type { Metadata } from "next";
import Link from "next/link";
import { permanentRedirect } from "next/navigation";
import { agreementMetas, type AgreementMeta } from "@/lib/server/agreements";

/// 契約與條款專區（公開，不需登入）。
///
/// 這些文件都放在版控的 markdown 裡，雜湊由檔案內容算出。介面顯示雜湊，
/// 是為了讓使用者事後能證明「我當時同意的是哪一版」——條文改一個字，雜湊就不一樣。
///
/// 每一份都有自己的網址 /agreements/<id>：法律文件會被引用、被存證、被貼進 email
/// 與函文裡，那個連結必須點開就是那一份，而不是「清單頁，然後請自己找」。
/// 這也是為什麼這一頁改成 server component——條文在伺服器端就渲染成 HTML，
/// 關掉 JavaScript、或用「另存新檔」，拿到的都是完整全文。

export const metadata: Metadata = {
  title: "契約與條款",
  description: "TideBit-DeFi 碳權交易所的定型化契約、網站服務條款與隱私權政策。每一份標示版本與內容雜湊。",
};

const GROUPS: { kind: AgreementMeta["kind"]; title: string; note: string }[] = [
  {
    kind: "contract",
    title: "定型化契約",
    note: "用到才簽，且簽的是「當下那一版的雜湊」。條文改版後會再次請您確認，舊的同意不會被沿用。",
  },
  {
    kind: "policy",
    title: "網站條款與政策",
    note: "瀏覽本站即適用，不另行簽署。修訂於生效日前三十日公告。",
  },
];

export default async function AgreementsIndex(props: PageProps<"/agreements">) {
  // 舊連結 /agreements?id=xxx 一路散在 email、公告與外部引用裡，不能讓它們變成 404。
  // 永久轉址而不是相容處理：這樣搜尋引擎與書籤會換到新網址，舊路徑自然凋零。
  const id = (await props.searchParams).id;
  if (typeof id === "string" && id) permanentRedirect(`/agreements/${encodeURIComponent(id)}`);

  const metas = agreementMetas();

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-tide">契約條款</p>
        <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-ink-50">契約與條款</h1>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-ink-200">
          買賣雙方在本站的權利義務由下列文件界定：五份定型化契約（含作為「平台使用約定書」附件、隨其生效的「服務流程說明書」），
          加上一進站就適用的「網站服務條款」與「隱私權政策」。
          每一份都標示版本與內容雜湊，並有自己的網址；您在操作時同意的是「當下那一版的雜湊」。
        </p>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-ink-200">
          <b>適用範圍</b>：本站為國際運行平台，同時交易多個轄區核發的減量額度。這些文件規範的是
          <b>本公司與用戶之間的平台服務關係</b>，依中華民國法律；<b>個別額度</b>的權利內容、移轉與註銷程序、
          可用途徑與申報效力，則依該額度<b>核發國</b>的法規與該國官方登錄簿的規定，不因為在本站交易而改變。
          兩者是不同層次。用戶並應自行遵守核發國與自身所在地／申報地的法規，本公司不提供法律意見。
        </p>
      </div>

      {GROUPS.map((g) => {
        const rows = metas.filter((m) => m.kind === g.kind);
        if (!rows.length) return null;
        return (
          <section key={g.kind} className="space-y-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-ink-50">{g.title}</h2>
              <p className="mt-1 max-w-3xl text-xs leading-6 text-ink-300">{g.note}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {rows.map((m) => (
                <Link
                  key={m.id}
                  href={`/agreements/${m.id}`}
                  data-testid={`doc-${m.id}`}
                  className="rounded-[--radius-card] border border-ink-500 bg-ink-700 p-4 transition hover:border-tide/60"
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h3 className="font-display text-base font-semibold text-ink-50">{m.title}</h3>
                    <span className="tnum rounded bg-ink-600 px-1.5 py-0.5 text-[11px] text-ink-300">{m.version}</span>
                  </div>
                  <p className="mt-1 text-xs text-ink-300">適用：{m.parties}．生效日 {m.effectiveDate}</p>
                  <p className="mt-2 text-sm leading-6 text-ink-200">{m.summary}</p>
                  <p className="tnum mt-2 font-mono text-[11px] break-all text-ink-300">{m.hash}</p>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
