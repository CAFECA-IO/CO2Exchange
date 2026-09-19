"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useAccount } from "./AccountProvider";

const links = [["/", "首頁"], ["/kyc", "身分驗證"], ["/trade", "購買與註銷"], ["/certificates", "我的憑證"]] as const;

export function Nav() {
  const path = usePathname();
  const { data: session } = useSession();
  const { credential } = useAccount();
  return (
    <header className="border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3">
        <Link href="/" className="font-semibold tracking-tight">CO2Exchange</Link>
        <nav className="flex gap-4 text-sm">
          {links.map(([href, label]) => (
            <Link key={href} href={href} className={path === href ? "font-medium text-emerald-700 dark:text-emerald-400" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"}>{label}</Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
          {credential && <span className="font-mono" title={credential.address}>{credential.address.slice(0, 6)}…{credential.address.slice(-4)}</span>}
          {session?.user && <button onClick={() => signOut({ callbackUrl: "/" })} className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">登出</button>}
        </div>
      </div>
    </header>
  );
}
