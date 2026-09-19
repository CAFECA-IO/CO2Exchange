"use client";
import { useCallback, useState } from "react";

/// 「掛載時抓一次、之後由事件重抓」的標準寫法。
///
/// 原本每一頁都是：`const refresh = useCallback(...setState...); useEffect(() => refresh(), [refresh])`。
/// 兩個問題：
///   1. 在 effect 裡直接呼叫會 setState 的函式，React 的 lint 會擋（連鎖渲染），
///      而且它分不出這是不是同步的。
///   2. 沒有取消機制。連點兩次「重新整理」，先發的請求可能後到，把新資料蓋回舊的。
///
/// 改成遞增一個 key：effect 依 key 重跑，抓完再用 ignore 旗標確認自己仍是最新那一次。
/// 呼叫端從 `await refresh()` 改成 `reload()`——不再等待，但畫面本來也不依賴那個等待。
export function useReload(): [number, () => void] {
  const [key, setKey] = useState(0);
  return [key, useCallback(() => setKey((k) => k + 1), [])];
}
