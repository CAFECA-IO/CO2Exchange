import type { Metadata } from "next";
import "./globals.css";
import { AccountProvider } from "@/components/AccountProvider";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "CO2Exchange",
  description: "減量額度登錄、交易與註銷平台（Phase 0）",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-TW" className="h-full antialiased">
      <body className="min-h-full bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <AccountProvider>
          <Nav />
          <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
        </AccountProvider>
      </body>
    </html>
  );
}
