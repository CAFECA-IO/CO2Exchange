export function Card({ title, children, className = "" }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${className}`}>
      {title && <h2 className="mb-3 text-base font-semibold">{title}</h2>}
      {children}
    </section>
  );
}
export function Button({ children, variant = "primary", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  const base = "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  const cls = variant === "primary"
    ? "bg-emerald-600 text-white hover:bg-emerald-700"
    : "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800";
  return <button className={`${base} ${cls}`} {...rest}>{children}</button>;
}
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm"><span className="mb-1 block text-zinc-600 dark:text-zinc-400">{label}</span>{children}</label>;
}
export const inputCls = "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950";
export function Notice({ kind = "info", children }: { kind?: "info" | "error" | "ok"; children: React.ReactNode }) {
  const cls = kind === "error" ? "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    : kind === "ok" ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
    : "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300";
  return <div className={`rounded-lg border px-3 py-2 text-sm ${cls}`} role={kind === "error" ? "alert" : undefined} data-testid={`notice-${kind}`}>{children}</div>;
}
export const fmtTwd = (raw: string | bigint) => (Number(raw) / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 2 });
export const fmtKg = (kg: number) => `${(kg / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 3 })} 噸`;
