"use client";
import { useSyncExternalStore } from "react";

/// 「現在幾點」是 React 之外的狀態，所以用訂閱的方式讀，不要在 render 裡呼叫
/// `Date.now()`（不純：同一份 props 畫出不同結果，SSR 與瀏覽器的第一次輸出也對不起來），
/// 也不要用 `useEffect` + `setState`（那會多一輪渲染，而且正是 set-state-in-effect
/// 規則要擋的東西）。
///
/// 一個 interval 服務所有訂閱者；沒有人訂閱時就停掉。
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 60_000);
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && timer) { clearInterval(timer); timer = null; }
  };
}

/// 伺服器端回 0：那一輪沒有時鐘，畫面該顯示「還沒量到」而不是一個會在
/// hydrate 時跳掉的數字。
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now, () => 0);
}
