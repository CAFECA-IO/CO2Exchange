"use client";
import { useEffect, useState } from "react";

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

export function ThemeToggle() {
  // 先以 system 呈現，掛載後再讀 localStorage —— 伺服器端算不出使用者選了什麼，
  // 直接渲染真實值會造成 hydration 不一致。避免閃爍是靠 layout 裡的 inline script。
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = (localStorage.getItem(THEME_KEY) as ThemeChoice | null) ?? "system";
    setChoice(saved);
    setReady(true);
  }, []);

  function pick(next: ThemeChoice) {
    setChoice(next);
    try {
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      /* 無痕模式等情況下寫不進去，畫面仍然照選的走 */
    }
    applyTheme(next);
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
          aria-checked={ready && choice === k}
          aria-label={LABEL[k]}
          title={LABEL[k]}
          onClick={() => pick(k)}
          className={`rounded px-1.5 py-1 transition ${
            ready && choice === k ? "bg-tide text-ink-900" : "text-ink-300 hover:bg-ink-600 hover:text-ink-50"
          }`}
        >
          {ICONS[k]}
        </button>
      ))}
    </div>
  );
}
