"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import type { Deployment } from "@/lib/deployment";
import { useReload } from "@/lib/client/useReload";
import {
  clearCredential, credentialServerSnapshot, credentialSnapshot, discoverPasskey, hasCode,
  registerPasskey, saveCredential, signAndRelay, signSelfIntent, subscribeCredential,
  type Call, type Intent, type RelayResult, type StoredCredential,
} from "@/lib/client/passkey";

// rpcUrl 不在這裡，也不該在這裡：**前端不直接跟區塊鏈說話**。
// 節點位址發給每一個訪客，等於把它暴露在公開網路上；而且瀏覽器連得到的節點
// 跟伺服器連得到的節點不一定是同一個，兩邊各讀一次就會各看到一條鏈。

/// 錢包的完整視圖。形狀與 /api/account 的回傳一致。
///
/// **地址由登入帳號決定，不由 passkey 決定。** 所以這份東西在「這台裝置還沒有
/// passkey」的時候一樣讀得到：使用者換一台手機登入，立刻看得到自己的地址、持倉、
/// 有哪些裝置在線上——他缺的只是「在這台裝置上簽字的能力」，那是另一件事。
export type WalletKey = { keyId: `0x${string}`; label: string; addedAt: number; credentialId?: string; publicKey?: `0x${string}` };
export type Wallet = {
  accountRef: `0x${string}`;
  address: `0x${string}`;
  exists: boolean;
  frozen: boolean;
  keys: WalletKey[];
  pendingDevices: { keyId: `0x${string}`; label: string; requestedAt: number; publicKey: `0x${string}` }[];
  recovery: { keyId: `0x${string}`; label: string; executeAfter: number } | null;
  recoveryDelay: number;
};

type Config = { deployment: Deployment; providers: string[] };
export type Me = { email: string | null; isAdmin: boolean; isVerifier: boolean };
/// 鏈上身分 + 本機的申請紀錄。`/api/kyc` 回的就是這個形狀。
export type Identity = {
  tier: number; expiry: number; frozen: boolean; jurisdiction: string; identityHash: string;
  application: { id: string; status: string; tier: number; reason?: string; createdAt: string } | null;
};

type Ctx = {
  config: Config | null;
  /// 這台裝置上**能用的** passkey。null ＝ 這台裝置簽不了字（但錢包可能好端端在鏈上）。
  ///
  /// 「能用」是關鍵：localStorage 裡有紀錄不代表那把金鑰還在錢包裡——別台裝置
  /// 可能剛把它撤掉。各頁用這個當交易門檻，就不會出現「畫面可以按、按下去必定失敗」。
  credential: StoredCredential | null;
  /// localStorage 裡的原始紀錄，不管還算不算數。只有「裝置與安全」那類要解釋
  /// 目前狀態的畫面才需要它。
  deviceCredential: StoredCredential | null;
  userId: string | null;
  me: Me;
  /// 這個登入帳號的錢包。null ＝ 還沒問到（不要在這時候斷言任何一邊）。
  wallet: Wallet | null;
  refreshWallet: () => void;
  /// 這台裝置的 passkey 還在錢包的有效金鑰裡嗎。被別台撤掉、或被復原流程換掉時會是 false。
  thisDeviceActive: boolean;
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
  /// 這台裝置記住的 passkey 已經不在錢包裡了（被撤銷，或部署換過）。
  /// 使用者沒做錯任何事，但畫面必須說出來 —— 否則就是「我明明有帳戶，怎麼什麼都按不動」。
  unbound: boolean;

  /// 第一次：建立錢包，這台裝置的 passkey 成為第一把金鑰。
  createAccount: () => Promise<void>;
  /// 這台裝置本來就有 passkey（清過瀏覽器資料、換個瀏覽器）：喚起它、把對照補回來。
  useExistingPasskey: () => Promise<void>;
  /// 在這台新裝置上建一把 passkey，送出「加入錢包」的請求。
  /// **不會立刻生效**——要某一台現有裝置核准。回傳是否進了待核准區。
  requestThisDevice: (label: string) => Promise<{ pending: boolean }>;
  /// 核准 / 拒絕一台待加入的裝置。核准要這台裝置的 passkey 簽字。
  approveDevice: (keyId: `0x${string}`, publicKey: `0x${string}`, label: string) => Promise<void>;
  rejectDevice: (keyId: `0x${string}`) => Promise<void>;
  /// 撤掉一把 passkey（裝置遺失、賣掉、離職）。最後一把撤不掉。
  removeDevice: (keyId: `0x${string}`) => Promise<void>;
  /// 掛失：只要登得進來就按得下去。解凍門檻高於凍結，這個不對稱是刻意的。
  freeze: () => Promise<void>;
  unfreeze: () => Promise<void>;
  /// 否決一個不是你發起的復原提案。
  cancelRecovery: () => Promise<void>;

  /// 送一筆交易。地址在**送出前**會先對現在這條鏈確認一次——這是每一筆交易的
  /// 唯一入口，各頁不要自己叫 signAndRelay。
  relay: (calls: Call[]) => Promise<RelayResult>;
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
  // 錢包也連同「這是誰的」一起存，同一個做法：換帳號時不必在 effect 裡先同步清空
  //（那正是 set-state-in-effect 規則要擋的東西），對不上就當作還沒問到。
  const [walletFor, setWalletFor] = useState<{ userId: string; wallet: Wallet } | null>(null);

  // 憑證的真實來源是 localStorage，不是 React state：訂閱它，不要複製一份再想辦法同步。
  const stored = useSyncExternalStore(subscribeCredential, credentialSnapshot, credentialServerSnapshot);
  // 憑證綁在登入帳號上。換了帳號，這台裝置上別人的憑證不算數。
  const deviceCredential = stored && stored.userId === userId ? stored : null;

  useEffect(() => { fetch("/api/config").then((r) => r.json()).then(setConfig).catch(() => setConfig(null)); }, []);
  useEffect(() => { fetch("/api/me").then((r) => r.json()).then(setMe).catch(() => {}); }, [userId]);

  const [walletKey, refreshWallet] = useReload();
  useEffect(() => {
    // 沒登入就什麼都不抓。也不需要清空既有狀態：walletFor 連同「這是誰的」一起存，
    // 對不上就當作還沒問到——在 effect 裡同步 setState 正是 React 要擋的東西。
    if (!userId) return;
    let ignore = false;
    fetch("/api/account")
      .then((r) => (r.ok ? r.json() : null))
      .then((w: Wallet | null) => { if (!ignore && w) setWalletFor({ userId, wallet: w }); })
      .catch(() => {});
    return () => { ignore = true; };
  }, [userId, walletKey]);

  const wallet = walletFor?.userId === userId ? walletFor.wallet : null;

  const thisDeviceActive = !!(
    deviceCredential?.keyId &&
    wallet?.keys.some((k) => k.keyId.toLowerCase() === deviceCredential.keyId!.toLowerCase())
  );
  // 「這台裝置的紀錄已經不算數了」：錢包在鏈上、我們也問到了它的金鑰清單，
  // 而這台裝置記著的那一把不在裡面。多半是被別台撤掉，或部署換過。
  const unbound = !!(deviceCredential && wallet?.exists && !thisDeviceActive);
  // 對外只給**還算數**的那一把。各頁因此不必自己判斷「有紀錄」與「能簽字」的差別，
  // 而那個差別漏判一次，就是一顆按下去必定失敗的按鈕。
  const credential = thisDeviceActive ? deviceCredential : null;

  // localStorage 裡的地址只是快取，會過期（合約重新部署、換一條鏈）。
  // 地址由登入帳號決定，伺服器隨時算得出來，所以對不上時直接把快取改對就好——
  // 不必問使用者、不必上鏈、也不需要重新簽任何東西。
  //
  // 少了這一段，過期的快取會一路影響到「這個地址簽過哪些契約」「這個地址的持倉」
  // 之類的查詢，畫面上就變成一堆按不動的按鈕，而沒有任何一句話解釋得了為什麼。
  // saveCredential 寫的是 localStorage（React 之外的狀態），不是 setState。
  useEffect(() => {
    if (!userId || !deviceCredential || !wallet?.exists) return;
    if (deviceCredential.address.toLowerCase() === wallet.address.toLowerCase()) return;
    saveCredential({ ...deviceCredential, address: wallet.address });
  }, [userId, deviceCredential, wallet]);

  const [tierKey, refreshTier] = useReload();
  useEffect(() => {
    const address = wallet?.address;
    if (!address || !wallet?.exists) return;
    let ignore = false;
    (async () => {
      const r = await fetch(`/api/kyc?account=${address}`);
      if (ignore || !r.ok) return;
      setIdFor({ address, identity: (await r.json()) as Identity, at: Date.now() });
    })();
    return () => { ignore = true; };
  }, [wallet?.address, wallet?.exists, tierKey]);

  // 身分是**別人**會改的東西：管理員在後台核准、查驗機構核發、主權角色凍結；
  // 錢包也是——另一台裝置可能剛剛撤掉了這一台。這個分頁不會自己知道，
  // 所以回到分頁時重抓一次。沒有這一段，使用者得整頁重新載入才看得到變化，
  // 而畫面上不會有任何提示告訴他要這麼做。
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === "visible") { refreshTier(); refreshWallet(); } };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshTier, refreshWallet]);

  const mine = idFor && wallet && idFor.address === wallet.address ? idFor : null;
  const identity = mine?.identity ?? null;
  const identityAt = mine?.at ?? 0;
  const tier = !identity || identity.frozen || identity.expiry * 1000 < identityAt ? 0 : identity.tier;

  /// 把一把 passkey 送到後端登記。回傳伺服器端看到的錢包狀態。
  /// created=true → 錢包剛剛被部署，這把是第一把金鑰。
  /// needsExistingKey=true → 錢包已經存在，這把進了待核准區。
  const post = useCallback(async (credentialId: string, publicKey: `0x${string}`, label: string) => {
    const res = await fetch("/api/account", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ credentialId, publicKey, label }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error ?? "account failed");
    setWalletFor({ userId: userId!, wallet: j as Wallet });
    return j as Wallet & { created?: boolean; needsExistingKey?: boolean; keyId: `0x${string}` };
  }, [userId]);

  const deviceName = useCallback(() => {
    // 給使用者自己看的預設名字。瀏覽器不會告訴我們「這是 Luphia 的 iPhone」，
    // 所以從 UA 猜一個大概，讓他之後在清單裡認得出來——認不出來就撤不掉。
    const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
    const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
      : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "裝置";
    const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari"
      : /Firefox\//.test(ua) ? "Firefox" : "";
    return br ? `${os} · ${br}` : os;
  }, []);

  const createAccount = useCallback(async () => {
    if (!userId) return;
    setBusy("建立 passkey…");
    try {
      const label = deviceName();
      const { id, publicKey } = await registerPasskey(`TideBit-DeFi 碳權交易所 · ${session?.user?.email ?? userId}`);
      setBusy("部署錢包（平台代付 gas）…");
      const w = await post(id, publicKey, label);
      if (w.needsExistingKey) {
        throw new Error("這個登入帳號已經有錢包了。這把新 passkey 已送出加入申請，請用一台已經在錢包裡的裝置核准。");
      }
      saveCredential({ id, publicKey, address: w.address, userId, keyId: w.keyId });
    } finally { setBusy(null); }
  }, [userId, session, post, deviceName]);

  const useExistingPasskey = useCallback(async () => {
    if (!userId) return;
    setBusy("等待 passkey…");
    try {
      const id = await discoverPasskey();
      const res = await fetch(`/api/account?credentialId=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error("這把 passkey 沒有對應的錢包紀錄，請改用「在這台裝置新增 passkey」");
      const j = (await res.json()) as { address: `0x${string}`; publicKey: `0x${string}`; keyId: `0x${string}` };
      saveCredential({ id, publicKey: j.publicKey, address: j.address, userId, keyId: j.keyId });
      refreshWallet();
    } finally { setBusy(null); }
  }, [userId, refreshWallet]);

  const requestThisDevice = useCallback(async (label: string) => {
    if (!userId) return { pending: false };
    setBusy("建立 passkey…");
    try {
      const { id, publicKey } = await registerPasskey(`TideBit-DeFi 碳權交易所 · ${session?.user?.email ?? userId}`);
      const w = await post(id, publicKey, label || deviceName());
      // 存下來，即使還沒生效：核准之後這台裝置就能直接用，不必再跳一次 passkey 建立流程。
      saveCredential({ id, publicKey, address: w.address, userId, keyId: w.keyId });
      return { pending: !!w.needsExistingKey };
    } finally { setBusy(null); }
  }, [userId, session, post, deviceName]);

  /// 需要這台裝置簽字的那幾個動作，共用同一條路：簽 → 送 → 重抓錢包。
  const selfAction = useCallback(async (label: string, intent: Intent) => {
    if (!credential) throw new Error("這台裝置沒有 passkey，無法簽署這個操作");
    setBusy(label);
    try {
      await signSelfIntent(credential, intent);
    } finally { setBusy(null); refreshWallet(); }
  }, [credential, refreshWallet]);

  const approveDevice = useCallback(async (keyId: `0x${string}`, publicKey: `0x${string}`, label: string) => {
    await selfAction("核准新裝置…", { kind: "addKey", publicKey, label });
    // 鏈上成功之後才把待核准旗標拿掉。順序反過來的話，交易失敗就會留下
    // 一台「顯示已核准、其實簽不了字」的裝置。
    await fetch("/api/account/pending", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keyId }),
    }).catch(() => {});
    refreshWallet();
  }, [selfAction, refreshWallet]);

  const rejectDevice = useCallback(async (keyId: `0x${string}`) => {
    await fetch(`/api/account/pending?keyId=${keyId}`, { method: "DELETE" });
    refreshWallet();
  }, [refreshWallet]);

  const removeDevice = useCallback((keyId: `0x${string}`) =>
    selfAction("移除裝置…", { kind: "removeKey", keyId }), [selfAction]);

  const unfreeze = useCallback(() => selfAction("解除凍結…", { kind: "unfreeze" }), [selfAction]);
  const cancelRecovery = useCallback(() => selfAction("否決復原提案…", { kind: "cancelRecovery" }), [selfAction]);

  const freeze = useCallback(async () => {
    setBusy("凍結錢包…");
    try {
      const res = await fetch("/api/account/freeze", { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "freeze failed");
    } finally { setBusy(null); refreshWallet(); }
  }, [refreshWallet]);

  // 每一筆交易都走這裡。
  //
  // 為什麼不是各頁直接叫 signAndRelay：重新部署之後，這個裝置記住的地址上沒有合約，
  // 而畫面在錢包重新問到之前就已經可以按了。在那個空窗按下去，送出的是舊地址，
  // 使用者看到一個他沒做錯任何事的錯誤。所以在送出前再確認一次。
  const relay = useCallback(async (calls: Call[]) => {
    if (!config) throw new Error("設定還沒載入");
    if (!credential) throw new Error("這台裝置沒有 passkey，無法簽署交易");
    // 地址以**伺服器**回報的為準，不是 localStorage 裡那一個。地址由登入帳號決定，
    // 伺服器隨時算得出來；瀏覽器存的那份只是快取，重新部署之後會過期。
    // 以快取為準的話，使用者會拿到一個他沒做錯任何事、重新整理就消失的錯誤。
    const address = wallet?.exists ? wallet.address : credential.address;
    if (!(await hasCode(address))) {
      refreshWallet();
      throw new Error("這個錢包在目前這條鏈上不存在，多半是剛剛重新部署過。請重新整理頁面後再試一次。");
    }
    return signAndRelay(credential, address, calls);
  }, [config, credential, wallet, refreshWallet]);

  const forget = useCallback(() => { clearCredential(); refreshWallet(); }, [refreshWallet]);

  const value = useMemo(
    () => ({
      config, credential, deviceCredential, userId, me, wallet, refreshWallet, thisDeviceActive,
      identity, identityAt, tier, refreshTier, busy, unbound,
      createAccount, useExistingPasskey, requestThisDevice, approveDevice, rejectDevice,
      removeDevice, freeze, unfreeze, cancelRecovery, relay, forget,
    }),
    [
      config, credential, deviceCredential, userId, me, wallet, refreshWallet, thisDeviceActive,
      identity, identityAt, tier, refreshTier, busy, unbound,
      createAccount, useExistingPasskey, requestThisDevice, approveDevice, rejectDevice,
      removeDevice, freeze, unfreeze, cancelRecovery, relay, forget,
    ],
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
