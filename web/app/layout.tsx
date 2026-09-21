import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AccountProvider } from "@/components/AccountProvider";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: { default: "TideBit-DeFi 碳權交易所", template: "%s｜TideBit-DeFi 碳權交易所" },
  description: "跨轄區碳權交易平台：核發、交易、註銷與託管揭露全程上鏈（Phase 0）",
  applicationName: "TideBit-DeFi 碳權交易所",
  // 圖示來自 TideBit-DeFi（CAFECA-IO/TideBit-DeFi），維持同一套品牌識別。
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
    ],
    apple: "/apple-touch-icon.png",
    other: [{ rel: "mask-icon", url: "/safari-pinned-tab.svg", color: "#29c1e1" }],
  },
  manifest: "/site.webmanifest",
};

/// 手機瀏覽器的網址列會用這個顏色。兩種佈景各給一個，不然淺色模式的網址列會是一塊黑。
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#161719" },
    { media: "(prefers-color-scheme: light)", color: "#f4f5f7" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // 首屏防閃爍的 inline script 會在 hydrate 之前就把 data-theme 寫到 <html> 上，
    // 伺服器端沒有這個屬性，React 會報 hydration mismatch。這是預期中的差異，
    // 所以在這一層（也只在這一層）關掉警告。
    <html lang="zh-TW" className="h-full antialiased" suppressHydrationWarning>
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
        {/*
          在第一次繪製之前把 data-theme 補上，否則手動選了淺色的人會先看到
          一閃的深色。沒存過選擇就什麼都不做，交給 prefers-color-scheme。
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("co2x.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
      </head>
      {/*
        flex 直欄 + main flex-1：內容短的頁（例如 404、或還在讀取的內頁）也要讓頁尾
        沉到視窗底部，而不是浮在畫面中間、下面一片空白。
      */}
      <body className="flex min-h-full flex-col bg-ink-800 font-sans text-ink-50">
        <AccountProvider>
          <Nav />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
          <Footer />
        </AccountProvider>
      </body>
    </html>
  );
}
