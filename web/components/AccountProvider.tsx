"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import type { Deployment } from "@/lib/deployment";
import { clearCredential, discoverPasskey, loadCredential, registerPasskey, saveCredential, type StoredCredential } from "@/lib/client/passkey";

type Config = { deployment: Deployment; rpcUrl: string; providers: string[] };
export type Me = { email: string | null; isAdmin: boolean; isVerifier: boolean };
type Ctx = {
  config: Config | null;
  credential: StoredCredential | null;
  userId: string | null;
  me: Me;
  tier: number; // 鏈上身分等級（0 未驗證 / 1 自然人 / 2 法人）
  refreshTier: () => Promise<void>;
  busy: string | null;
  createAccount: () => Promise<void>;
  useExistingPasskey: () => Promise<void>;
  forget: () => void;
};
const AccountCtx = createContext<Ctx | null>(null);

function Inner({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  const [config, setConfig] = useState<Config | null>(null);
  const [credential, setCredential] = useState<StoredCredential | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [me, setMe] = useState<Me>({ email: null, isAdmin: false, isVerifier: false });
  const [tier, setTier] = useState(0);

  useEffect(() => { fetch("/api/config").then((r) => r.json()).then(setConfig).catch(() => setConfig(null)); }, []);
  useEffect(() => { fetch("/api/me").then((r) => r.json()).then(setMe).catch(() => {}); }, [userId]);
  const refreshTier = useCallback(async () => {
    if (!credential) { setTier(0); return; }
    const r = await fetch(`/api/kyc?account=${credential.address}`);
    if (r.ok) { const j = await r.json(); setTier(j.frozen || j.expiry * 1000 < Date.now() ? 0 : j.tier); }
  }, [credential]);
  useEffect(() => { refreshTier(); }, [refreshTier]);
  useEffect(() => { setCredential(userId ? loadCredential(userId) : null); }, [userId]);

  const bind = useCallback(async (id: string, publicKey: `0x${string}`) => {
    const res = await fetch("/api/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credentialId: id, publicKey }) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error ?? "account failed");
    const c: StoredCredential = { id, publicKey, address: j.address, userId: userId! };
    saveCredential(c); setCredential(c);
  }, [userId]);

  const createAccount = useCallback(async () => {
    if (!userId) return;
    setBusy("建立 passkey…");
    try {
      const { id, publicKey } = await registerPasskey(`CO2Exchange · ${session?.user?.email ?? userId}`);
      setBusy("部署帳戶（平台代付 gas）…");
      await bind(id, publicKey);
    } finally { setBusy(null); }
  }, [userId, session, bind]);

  const useExistingPasskey = useCallback(async () => {
    if (!userId) return;
    setBusy("等待 passkey…");
    try {
      const id = await discoverPasskey();
      const res = await fetch(`/api/account?credentialId=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error("這把 passkey 沒有對應帳戶，請改用「建立新帳戶」");
      const j = await res.json();
      const c: StoredCredential = { id, publicKey: j.publicKey, address: j.address, userId };
      saveCredential(c); setCredential(c);
    } finally { setBusy(null); }
  }, [userId]);

  const forget = useCallback(() => { clearCredential(); setCredential(null); }, []);

  const value = useMemo(() => ({ config, credential, userId, me, tier, refreshTier, busy, createAccount, useExistingPasskey, forget }), [config, credential, userId, me, tier, refreshTier, busy, createAccount, useExistingPasskey, forget]);
  return <AccountCtx.Provider value={value}>{children}</AccountCtx.Provider>;
}

export function AccountProvider({ children }: { children: React.ReactNode }) {
  return <SessionProvider><Inner>{children}</Inner></SessionProvider>;
}

export function useAccount() {
  const ctx = useContext(AccountCtx);
  if (!ctx) throw new Error("useAccount outside provider");
  return ctx;
}
