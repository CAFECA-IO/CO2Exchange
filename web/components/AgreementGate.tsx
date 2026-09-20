"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Notice } from "./ui";
import { useReload } from "@/lib/client/useReload";

/// 定型化契約的簽署關卡。
///
/// 規則：條文改版 = 雜湊改變 = 要重簽。所以這裡問的是「這個帳戶簽過**這一版**了沒」，
/// 不是「簽過這份契約了沒」。
///
/// 消保法第 11-1 條的審閱期：我們記下使用者把條文展開來看的時間（reviewStartedAt），
/// 連同同意紀錄一起存。展示版不強制等待三日，但時間戳留著，正式版要改成擋下即可。

export type AgreementMeta = { id: string; title: string; version: string; summary: string; hash: string; parties: string };

export type Gate = {
  loading: boolean;
  missing: AgreementMeta[];
  checked: Record<string, boolean>;
  toggle: (id: string) => void;
  markOpened: (id: string) => void;
  /// 全部該簽的都勾了
  ok: boolean;
  /// 在送出交易前呼叫：把同意紀錄寫下來
  accept: (context?: string) => Promise<void>;
};

export function useAgreementGate(account: string | undefined, ids: readonly string[]): Gate {
  const [missing, setMissing] = useState<AgreementMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [openedAt, setOpenedAt] = useState<Record<string, string>>({});
  const [reloadKey, reload] = useReload();
  const need = ids.join(",");

  useEffect(() => {
    if (!account) return;
    let ignore = false;
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/agreements?account=${account}&need=${need}`);
        const j = await r.json();
        if (!ignore && r.ok) setMissing(j.missing ?? []);
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => { ignore = true; };
  }, [account, need, reloadKey]);

  const toggle = useCallback((id: string) => setChecked((c) => ({ ...c, [id]: !c[id] })), []);
  const markOpened = useCallback(
    (id: string) => setOpenedAt((o) => (o[id] ? o : { ...o, [id]: new Date().toISOString() })),
    [],
  );

  const ok = missing.every((m) => checked[m.id]);

  const accept = useCallback(async (context?: string) => {
    if (!account || missing.length === 0) return;
    const r = await fetch("/api/agreements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account,
        ids: missing.map((m) => m.id),
        reviewStartedAt: openedAt[missing[0].id],
        context,
      }),
    });
    if (!r.ok) throw new Error((await r.json()).error ?? "契約簽署失敗");
    reload();
  }, [account, missing, openedAt, reload]);

  return { loading, missing, checked, toggle, markOpened, ok, accept };
}

export function AgreementCheck({ gate }: { gate: Gate }) {
  if (gate.loading || gate.missing.length === 0) return null;
  return (
    <div className="rounded-[--radius-ctl] border border-ink-500 bg-ink-800 p-3">
      <p className="text-xs text-ink-300">本次操作需先同意下列定型化契約（條文改版後會再次請您確認）：</p>
      <ul className="mt-2 space-y-2">
        {gate.missing.map((m) => (
          <li key={m.id} className="text-sm">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1 accent-[--color-tide]"
                checked={!!gate.checked[m.id]}
                onChange={() => gate.toggle(m.id)}
                data-testid={`agree-${m.id}`}
              />
              <span className="text-ink-200">
                我已閱讀並同意
                <Link
                  href={`/agreements?id=${m.id}`}
                  target="_blank"
                  onClick={() => gate.markOpened(m.id)}
                  className="mx-1 text-tide underline"
                >
                  《{m.title}》{m.version}
                </Link>
                <span className="block text-xs text-ink-300">{m.summary}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/// 給沒有帳戶或尚未載入時的簡短提示
export function AgreementPending() {
  return <Notice>讀取契約狀態中…</Notice>;
}
