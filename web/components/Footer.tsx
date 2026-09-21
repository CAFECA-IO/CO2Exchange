import Link from "next/link";

/// 全站頁尾。
///
/// 隱私權政策與服務條款的慣例位置就是這裡：它們適用於**每一頁**，
/// 包含使用者不會走到 /agreements 的那些頁。放在導覽列會把一條已經很長的列擠爆，
/// 而且這兩份不是「功能」，是「看得到、找得到就好」的東西。
///
/// Phase 0 聲明也放這裡，而不是只放在首頁——會被外部連結指進來的是內頁，
/// 那些人沒看過首頁的說明。

const LINKS = [
  ["/agreements/privacy-policy", "隱私權政策"],
  ["/agreements/terms-of-service", "服務條款"],
  ["/agreements", "契約與條款"],
  ["/custody", "託管揭露"],
  ["/about", "認識碳權"],
] as const;

export function Footer() {
  return (
    <footer className="mt-16 border-t border-ink-500">
      <div className="mx-auto max-w-6xl space-y-3 px-4 py-8 text-xs leading-6 text-ink-300">
        <nav className="flex flex-wrap gap-x-5 gap-y-1">
          {LINKS.map(([href, label]) => (
            <Link key={href} href={href} className="transition hover:text-ink-50">{label}</Link>
          ))}
        </nav>
        <p>
          本站目前為 <b className="text-ink-200">Phase 0 展示版本</b>：身分驗證、查驗機構簽章與結算幣皆為模擬，
          額度不具法律效力，不得作為任何申報依據。
        </p>
        <p>
          © {new Date().getFullYear()} 卡菲卡金融科技股份有限公司（CAFECA Fintech Co., Ltd.）．
          個資與條款聯絡窗口 <a href="mailto:contact@tidebit-defi.com" className="text-tide underline underline-offset-2">contact@tidebit-defi.com</a>
        </p>
      </div>
    </footer>
  );
}
