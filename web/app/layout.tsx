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
      <head>
        {/*
          TideBit-DeFi 用 Barlow（標題 / 數字）+ Inter（內文）。
          這裡用 <link> 而不是 next/font/google：next/font 會在「build 時」抓字型，
          離線或受限網路的建置環境會直接失敗。瀏覽器端載入則有系統字型可退回。
          正式上線前建議改為自架字型檔（next/font/local），少一個外部相依。
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Barlow:wght@500;600;700&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full bg-ink-800 font-sans text-ink-50">
        <AccountProvider>
          <Nav />
          <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        </AccountProvider>
      </body>
    </html>
  );
}
