"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useAccount } from "./AccountProvider";
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
] as const;

export function Nav() {
  const path = usePathname();
  const { data: session } = useSession();
  const { credential, me, tier } = useAccount();
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
                  ? "border-b-2 border-tide pb-0.5 font-medium text-tide"
                  : "pb-0.5 text-ink-300 transition hover:text-ink-50"
              }
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs text-ink-300">
          <ThemeToggle />
          {/*
            登入狀態與鏈上帳戶要分開顯示。只顯示「登出」而不說帳戶還沒建立，
            使用者進到內頁看到「請先建立鏈上帳戶」就會覺得自相矛盾。
          */}
          {credential ? (
            <span className="tnum font-mono text-ink-200" title={credential.address}>
              {credential.address.slice(0, 6)}…{credential.address.slice(-4)}
            </span>
          ) : session?.user ? (
            <Link href="/" className="rounded-[--radius-ctl] border border-warn/50 px-2 py-1 text-warn transition hover:border-warn">
              尚未建立鏈上帳戶
            </Link>
          ) : null}
          {session?.user && (
            <button
              onClick={() => signOut({ callbackUrl: "/" })}
              className="rounded-[--radius-ctl] border border-ink-500 px-2 py-1 transition hover:border-tide/60 hover:text-ink-50"
            >
              登出
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
