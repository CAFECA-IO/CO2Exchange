"use client";
import { useRouter } from "next/navigation";
import { Button, Card, Notice } from "@/components/ui";

/// 沒有這一支的話，頁面渲染時丟出的例外會換成 Next 的預設錯誤畫面
///（正式環境是一片「Application error」，什麼都看不出來），而且**沒有重試**——
/// 使用者唯一能做的是重新整理，如果他想得到的話。
///
/// `reset()` 只重掛這一段子樹，不重載整頁：連線恢復之後按一下就回來了，
/// 不必重跑登入與所有初始請求。
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  return (
    <Card title="這一頁出了點問題">
      <div className="space-y-3 text-sm leading-7 text-ink-200">
        <p>你的帳戶與資產不受影響——出問題的是這一次的畫面。</p>
        {/* 開發時看得到訊息；正式環境 Next 會把訊息換成 digest，那就顯示 digest，
            至少客服對得起來是哪一次錯誤。 */}
        <Notice kind="error">{error.message || `錯誤代碼 ${error.digest ?? "未知"}`}</Notice>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={reset}>重試</Button>
        <Button variant="secondary" onClick={() => router.push("/")}>回首頁</Button>
      </div>
    </Card>
  );
}
