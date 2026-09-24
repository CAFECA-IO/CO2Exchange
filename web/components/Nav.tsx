"use client";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useAccount } from "./AccountProvider";
import { hasLogin } from "@/lib/login";
import { LogoMark } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";

const base = [
  ["/", "首頁"],
  ["/about", "認識碳權"],
  ["/kyc", "身分驗證"],
  ["/trade", "交易"],
  ["/portfolio", "我的資產"],
  ["/retire", "註銷"],
  ["/registry", "公告欄"],
  ["/custody", "託管揭露"],
  ["/agreements", "契約"],
  ["/account", "裝置與安全"],
] as const;

/// 點下去到新頁畫出來之間，導覽列上那個連結旁邊亮一個點。
///
/// 為什麼需要：App Router 在載入下一頁時舊畫面會留在原地，於是「按了沒反應」與
/// 「正在載入」長得一模一樣，而使用者只會再按一次。
///
/// 為什麼不是用 app/loading.tsx 的骨架：**那會把伺服器端的轉址變成串流的 200**。
/// /agreements?id=… 用 `permanentRedirect` 發 308，就是為了讓搜尋引擎與書籤換到新網址；
/// 一旦路由上有 loading 邊界，Next 會先把骨架串出去（200），轉址退化成前端跳轉，
/// 那個 308 就沒了。實測驗證過。而且這幾頁的等待其實發生在**掛載之後**的
/// 資料請求，loading 邊界本來也蓋不到——代價真實，好處幾乎沒有。
///
/// `useLinkStatus` 只能在 <Link> 的子樹裡用，所以拆成一個小元件。
function Pending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span
      className="ml-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-tide motion-safe:animate-pulse"
      role="status"
      aria-label="載入中"
    />
  );
}

export function Nav() {
  const path = usePathname();
  const { data: session } = useSession();
  const { me, tier, config, wallet, thisDeviceActive } = useAccount();
  const links: readonly (readonly [string, string])[] = [
    ...base,
    ...(tier === 2 ? [["/enterprise", "企業"] as const] : []),
    ...(me.isVerifier ? [["/verifier", "查驗機構"] as const] : []),
    ...(me.isAdmin ? [["/admin", "管理後台"] as const] : []),
  ];
  return (
    <header className="sticky top-0 z-50 border-b border-ink-500 bg-ink-900/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        {/*
          品牌：TideBit-DeFi 碳權交易所。標記用 currentColor 畫外框，所以它跟著
          文字色走，淺色模式不會變成一塊看不見的白。中文全名在窄螢幕收起來——
          那時候標記與英文字樣已經夠認人了。
        */}
        <Link href="/" className="flex items-center gap-2.5 text-ink-50" aria-label="TideBit-DeFi 碳權交易所">
          <LogoMark className="h-7 w-auto shrink-0" />
          <span className="font-display text-base font-bold leading-none tracking-tight">
            TideBit<span className="text-tide">-DeFi</span>
          </span>
          <span className="hidden h-4 w-px bg-ink-500 sm:block" aria-hidden />
          <span className="hidden text-sm text-ink-300 sm:block">碳權交易所</span>
        </Link>
        <nav className="flex flex-wrap gap-4 text-sm">
          {links.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className={
                path === href
                  ? "flex items-center border-b-2 border-tide pb-0.5 font-medium text-tide"
                  : "flex items-center pb-0.5 text-ink-300 transition hover:text-ink-50"
              }
            >
              {label}
              <Pending />
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs text-ink-300">
          <ThemeToggle />
          {/*
            登入狀態與鏈上帳戶要分開顯示。只顯示「登出」而不說帳戶還沒建立，
            使用者進到內頁看到「請先建立鏈上帳戶」就會覺得自相矛盾。
          */}
          {/*
            地址來自**錢包**而不是這台裝置的 passkey：地址由登入帳號決定，
            所以就算這台裝置還沒配鑰匙，使用者一樣該看得到自己的地址。
            凍結中另外標一筆——那是使用者最需要一眼看到的狀態。
          */}
          {wallet?.exists ? (
            <Link href="/account" className="flex items-center gap-1.5" title={wallet.address}>
              {wallet.frozen && <span className="rounded-[--radius-ctl] bg-warn/15 px-1.5 py-0.5 text-warn">已凍結</span>}
              <span className="tnum font-mono text-ink-200 transition hover:text-ink-50">
                {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
              </span>
              {!thisDeviceActive && <span className="text-warn">· 這台裝置無法簽署</span>}
            </Link>
          ) : session?.user && wallet ? (
            <Link href="/#login" className="rounded-[--radius-ctl] border border-warn/50 px-2 py-1 text-warn transition hover:border-warn">
              尚未建立鏈上錢包
            </Link>
          ) : null}
          {session?.user ? (
            <button
              onClick={() => signOut({ callbackUrl: "/" })}
              className="rounded-[--radius-ctl] border border-ink-500 px-2 py-1 transition hover:border-tide/60 hover:text-ink-50"
            >
              登出
            </button>
          ) : hasLogin(config?.providers) ? (
            /*
              登入只在首頁的 hero 裡有入口，從任何內頁都回不去——手機上尤其明顯，
              導覽列一換行，首頁的 hero 就在兩個捲動之外。這裡放一個常駐的入口，
              但不重做一套登入 UI：指到首頁的 #login，維持單一登入畫面。

              站台沒開任何登入方式時不畫這顆：指到一個什麼都沒有的地方，
              比沒有入口更難理解。
            */
            <Link
              href="/#login"
              className="rounded-[--radius-ctl] border border-tide/50 px-2 py-1 text-tide transition hover:border-tide hover:text-ink-50"
            >
              登入
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}
