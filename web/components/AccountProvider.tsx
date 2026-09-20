"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import type { Deployment } from "@/lib/deployment";
import { useReload } from "@/lib/client/useReload";
import { clearCredential, credentialServerSnapshot, credentialSnapshot, discoverPasskey, hasCode, registerPasskey, saveCredential, subscribeCredential, type StoredCredential } from "@/lib/client/passkey";

type Config = { deployment: Deployment; rpcUrl: string; providers: string[] };
export type Me = { email: string | null; isAdmin: boolean; isVerifier: boolean };
/// 鏈上身分 + 本機的申請紀錄。`/api/kyc` 回的就是這個形狀。
export type Identity = {
  tier: number; expiry: number; frozen: boolean; jurisdiction: string; identityHash: string;
  application: { id: string; status: string; tier: number; reason?: string; createdAt: string } | null;
};
type Ctx = {
  config: Config | null;
  credential: StoredCredential | null;
  userId: string | null;
  me: Me;
  /// 身分只有這一份。**任何頁面都不要自己再 fetch 一次 `/api/kyc`**——
  /// 以前 /kyc 自己存一份、AccountProvider 存另一份，兩邊各自決定什麼時候刷新，
  /// 於是「/kyc 顯示法人有效，同一時間 /trade 說你沒驗證」。
  /// 那不是同步沒做好，是同一份資料放了兩份。
  identity: Identity | null;
  /// 拿到 identity 的時間。效期要在取得資料的當下比，render 期間不呼叫 Date.now()。
  identityAt: number;
  tier: number; // 鏈上身分等級（0 未驗證 / 1 自然人 / 2 法人）
  refreshTier: () => void;
  busy: string | null;
  /// 這個裝置原本綁著的帳戶，在目前的部署上不存在，自動重綁也失敗了，已解除綁定。
  /// 使用者沒做錯任何事，但畫面必須說出來 —— 否則就是「我明明有帳戶，怎麼叫我重建」。
  unbound: boolean;
  createAccount: () => Promise<void>;
  useExistingPasskey: () => Promise<void>;
  forget: () => void;
};
const AccountCtx = createContext<Ctx | null>(null);

function Inner({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  const [config, setConfig] = useState<Config | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [me, setMe] = useState<Me>({ email: null, isAdmin: false, isVerifier: false });
  // 身分連同它屬於哪個地址一起存。這樣換帳戶時不必先清空
  //（那是在 effect 裡同步改狀態），對不上就直接當未驗證。
  const [idFor, setIdFor] = useState<{ address: string; identity: Identity; at: number } | null>(null);
  const [unbound, setUnbound] = useState(false);

  // 憑證的真實來源是 localStorage，不是 React state：訂閱它，不要複製一份再想辦法同步。
  const stored = useSyncExternalStore(subscribeCredential, credentialSnapshot, credentialServerSnapshot);
  // 憑證綁在登入帳號上。換了帳號，這台裝置上別人的憑證不算數。
  const credential = stored && stored.userId === userId ? stored : null;

  useEffect(() => { fetch("/api/config").then((r) => r.json()).then(setConfig).catch(() => setConfig(null)); }, []);
  useEffect(() => { fetch("/api/me").then((r) => r.json()).then(setMe).catch(() => {}); }, [userId]);
  const [tierKey, refreshTier] = useReload();
  useEffect(() => {
    if (!credential) return;
    const address = credential.address;
    let ignore = false;
    (async () => {
      const r = await fetch(`/api/kyc?account=${address}`);
      if (ignore || !r.ok) return;
      setIdFor({ address, identity: (await r.json()) as Identity, at: Date.now() });
    })();
    return () => { ignore = true; };
  }, [credential, tierKey]);

  // 身分是**別人**會改的東西：管理員在後台核准、查驗機構核發、主權角色凍結。
  // 這個分頁不會自己知道，所以回到分頁時重抓一次。
  // 沒有這一段，使用者得整頁重新載入才看得到核准結果——而畫面上不會有任何提示
  // 告訴他要這麼做，他只會覺得「我明明已經核准了，為什麼還說我沒驗證」。
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === "visible") refreshTier(); };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshTier]);

  const mine = idFor && credential && idFor.address === credential.address ? idFor : null;
  const identity = mine?.identity ?? null;
  const identityAt = mine?.at ?? 0;
  const tier = !identity || identity.frozen || identity.expiry * 1000 < identityAt ? 0 : identity.tier;
  const bind = useCallback(async (id: string, publicKey: `0x${string}`) => {
    const res = await fetch("/api/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credentialId: id, publicKey }) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error ?? "account failed");
    const c: StoredCredential = { id, publicKey, address: j.address, userId: userId! };
    saveCredential(c); setUnbound(false);
  }, [userId]);

  // 合約重新部署後，factory 位址會變，同一把 passkey 推出來的帳戶地址也跟著變，
  // 但這個裝置記住的還是舊地址 —— 那個地址上沒有合約，任何操作都會失敗。
  // passkey 才是真正的身分，地址只是推導結果，所以這裡直接拿同一把公鑰
  // 對現在的 factory 重新綁定，使用者不需要知道發生過什麼事。
  useEffect(() => {
    if (!credential || !config || !userId) return;
    let live = true;
    (async () => {
      if (await hasCode(config.rpcUrl, credential.address)) return;
      if (!live) return;
      setBusy("合約已更新，重新綁定帳戶…");
      try {
        await bind(credential.id, credential.publicKey);
      } catch {
        // 重綁失敗（例如這把 passkey 沒對應紀錄）就清掉，讓使用者重新建立，
        // 而不是留著一個永遠失敗的地址。
        if (live) { clearCredential(); setUnbound(true); }
      } finally {
        if (live) setBusy(null);
      }
    })();
    return () => { live = false; };
    // bind 會隨 userId 變動；credential.address 是實際要檢查的東西
  }, [credential, config, userId, bind]);


  const createAccount = useCallback(async () => {
    if (!userId) return;
    setBusy("建立 passkey…");
    try {
      const { id, publicKey } = await registerPasskey(`TideBit-DeFi 碳權交易所 · ${session?.user?.email ?? userId}`);
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
      saveCredential({ id, publicKey: j.publicKey, address: j.address, userId });
      setUnbound(false);
    } finally { setBusy(null); }
  }, [userId]);

  const forget = useCallback(() => { clearCredential(); setUnbound(false); }, []);

  const value = useMemo(
    () => ({ config, credential, userId, me, identity, identityAt, tier, refreshTier, busy, unbound, createAccount, useExistingPasskey, forget }),
    [config, credential, userId, me, identity, identityAt, tier, refreshTier, busy, unbound, createAccount, useExistingPasskey, forget],
  );
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
