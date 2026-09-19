"use client";
import { useEffect, useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export const THEME_KEY = "co2x.theme";

/// 只有 light / dark 會寫成 data-theme；system 則移除屬性，交還給
/// globals.css 的 prefers-color-scheme media query。
export function applyTheme(choice: ThemeChoice) {
  const el = document.documentElement;
  if (choice === "system") el.removeAttribute("data-theme");
  else el.dataset.theme = choice;
}

const ICONS: Record<ThemeChoice, React.ReactNode> = {
  system: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
  light: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  ),
};

const LABEL: Record<ThemeChoice, string> = { system: "跟隨系統", light: "淺色", dark: "深色" };

/// 使用者選的配色存在 localStorage，那是 React 之外的狀態，所以用 useSyncExternalStore
/// 訂閱，而不是「先渲染 system、掛載後再 setState 改成真值」——後者每次進站都多一輪
/// 渲染。伺服器端沒有 localStorage，一律回 "system"，hydrate 之後才會是真值；
/// 首屏不閃爍是靠 layout 裡的 inline script，與這裡無關。
/// 另一個分頁改了設定，storage 事件也會同步過來。
const themeListeners = new Set<() => void>();
function subscribeTheme(cb: () => void) {
  themeListeners.add(cb);
  window.addEventListener("storage", cb);
  return () => { themeListeners.delete(cb); window.removeEventListener("storage", cb); };
}
function themeSnapshot(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch { return "system"; }
}
function themeServerSnapshot(): ThemeChoice { return "system"; }

export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribeTheme, themeSnapshot, themeServerSnapshot);

  // 把選擇套到 <html> 上。這是「用 React 狀態去同步外部系統」，effect 的正當用途。
  // 放在這裡而不是放在 pick() 裡，另一個分頁改設定時這個分頁才會跟著換色，
  // 而不是只有按鈕的高亮跟著動。
  useEffect(() => { applyTheme(choice); }, [choice]);

  function pick(next: ThemeChoice) {
    try {
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      /* 無痕模式等情況下寫不進去，畫面仍然照選的走 */
    }
    for (const l of themeListeners) l(); // 通知訂閱者（含上面的 effect）重新讀 snapshot
  }

  return (
    <div
      role="radiogroup"
      aria-label="配色模式"
      className="flex items-center gap-0.5 rounded-[--radius-ctl] border border-ink-500 p-0.5"
    >
      {(["system", "light", "dark"] as const).map((k) => (
        <button
          key={k}
          role="radio"
          aria-checked={choice === k}
          aria-label={LABEL[k]}
          title={LABEL[k]}
          onClick={() => pick(k)}
          className={`rounded px-1.5 py-1 transition ${
            choice === k ? "bg-tide text-ink-900" : "text-ink-300 hover:bg-ink-600 hover:text-ink-50"
          }`}
        >
          {ICONS[k]}
        </button>
      ))}
    </div>
  );
}
