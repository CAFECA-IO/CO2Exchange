export function Card({ title, children, className = "", action }: { title?: string; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  return (
    <section className={`rounded-[--radius-card] border border-ink-500 bg-ink-700 p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="font-display text-base font-semibold text-ink-50">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({ children, variant = "primary", className = "", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  const base =
    "inline-flex items-center justify-center rounded-[--radius-ctl] px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  const cls =
    variant === "primary"
      ? "bg-tide text-ink-900 hover:brightness-110"
      : variant === "ghost"
        ? "text-ink-200 hover:bg-ink-600 hover:text-ink-50"
        : "border border-ink-500 bg-ink-600 text-ink-50 hover:border-tide/60 hover:bg-ink-500";
  return <button className={`${base} ${cls} ${className}`} {...rest}>{children}</button>;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-ink-300">{label}</span>
      {children}
    </label>
  );
}

export const inputCls =
  "w-full rounded-[--radius-ctl] border border-ink-500 bg-ink-800 px-3 py-2 text-sm text-ink-50 outline-none placeholder:text-ink-300 focus:border-tide";

/// `warn` 與 `error` 分開，不是為了多一個顏色：**「要你注意」不等於「出錯了」**。
/// 「有人正在申請加入你的錢包」是前者——系統運作正常，需要你做決定；
/// 把它畫成錯誤，使用者會以為是故障，而真正的錯誤訊息也跟著貶值。
/// （順帶一提，e2e 用 `notice-error` 判斷「頁面壞了」，混用會讓測試自己說謊。）
export function Notice({ kind = "info", children }: { kind?: "info" | "error" | "warn" | "ok"; children: React.ReactNode }) {
  const cls =
    kind === "error"
      ? "border-down/40 bg-down/10 text-down"
      : kind === "warn"
        ? "border-warn/40 bg-warn/10 text-warn"
        : kind === "ok"
          ? "border-up/40 bg-up/10 text-up"
          : "border-ink-500 bg-ink-600 text-ink-200";
  return (
    <div className={`rounded-[--radius-ctl] border px-3 py-2 text-sm ${cls}`} role={kind === "error" ? "alert" : undefined} data-testid={`notice-${kind}`}>
      {children}
    </div>
  );
}

/// 漲跌一律附正負號與 ▲/▼，色盲讀者不靠顏色也能判讀。
export function Delta({ value, suffix = "%", className = "" }: { value: number; suffix?: string; className?: string }) {
  const up = value > 0;
  const flat = value === 0;
  const color = flat ? "text-ink-200" : up ? "text-up" : "text-down";
  const mark = flat ? "" : up ? "▲ " : "▼ ";
  const sign = value > 0 ? "+" : "";
  return (
    <span className={`${color} ${className}`}>
      {mark}
      {sign}
      {value.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}
      {suffix}
    </span>
  );
}

export const fmtTwd = (raw: string | bigint) => (Number(raw) / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 2 });
export const fmtKg = (kg: number) => `${(kg / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 3 })} 噸`;
