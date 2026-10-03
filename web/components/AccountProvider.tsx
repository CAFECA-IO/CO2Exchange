"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import type { Deployment } from "@/lib/deployment";
import { useReload } from "@/lib/client/useReload";
import { fetchJson, type ApiClientError } from "@/lib/client/fetchJson";
import {
  currentChannel, messageFor, sendCallsViaChannel, signTypedDataViaChannel,
  type Call, type Description,
} from "@/lib/client/cafeca";

// rpcUrl 不在這裡，也不該在這裡：**前端不直接跟區塊鏈說話**。
// 節點位址發給每一個訪客，等於把它暴露在公開網路上；而且瀏覽器連得到的節點
// 跟伺服器連得到的節點不一定是同一個，兩邊各讀一次就會各看到一條鏈。

/// 使用者的錢包視圖。形狀與 /api/account 的回傳一致。
///
/// ## 這份東西在改用 CAFECA 之後小了很多，而那正是重點
///
/// 以前它要描述一整套金鑰生命週期：有哪些 passkey、哪一把在這台裝置上、
/// 有沒有待核准的新裝置、有沒有進行中的復原提案、凍結了沒。因為錢包是本站的
/// `PasskeyAccount`，那些都歸我們管。
///
/// 現在錢包是使用者的 CAFECA 身分合約，**金鑰生命週期不歸我們管**。
/// 加裝置、撤金鑰、以實體卡恢復，全部在 CAFECA 錢包裡做。這是好事：
/// 那些是身分層最敏感的操作，而本站是一個交易所，不該有能力碰它們。
export type Wallet = {
  address: `0x${string}`;
  /// 這個地址上有沒有合約。CAFECA 帳戶是 ERC-4337，第一次動作前可能還沒部署
  /// （地址早就算得出來，但鏈上還是空的）。
  exists: boolean;
  /// 有人正在主張這個帳戶是他的。敏感操作要停。
  recoveryPending: boolean;
  /// 0 未實名 / 2 證件＋臉部（IdentityRegistry v2 的有效等級）。AI 子錢包不會有實名等級。
  kycLevel: number;
  /// CAFECA 實名的完整狀態：自然人或法人、簽章者等級（原型／正式）、效期
  kyc?: { subjectType: "person" | "entity"; level: number; effectiveLevel: number; status: string; expiry: number; jurisdiction: string; signerClass: string } | null;
  /// 要管理金鑰、裝置或發動恢復時該去的地方。本站做不到，也不該做到。
  manageUrl: string;
};

type Config = { deployment: Deployment; providers: string[] };
export type Me = { address: string | null; handle: string | null; isAdmin: boolean; isVerifier: boolean };
/// 鏈上身分 + 本機的申請紀錄。`/api/kyc` 回的就是這個形狀。
export type Identity = {
  tier: number; expiry: number; frozen: boolean; jurisdiction: string; identityHash: string;
  application: { id: string; status: string; tier: number; reason?: string; createdAt: string; source?: string } | null;
  /// CAFECA 實名（只有帳戶本人看得到）
  cafeca?: {
    record: { status: string; tier: number; reason?: string; subjectType?: string; signerClass?: string; expiry?: number; docType?: string | null; jurisdiction?: string; checkedAt?: string } | null;
    last: { adopted: boolean; reason?: string; at: string } | null;
    acceptPrototype: boolean;
    manualIndividual: boolean;
  } | null;
};

type Ctx = {
  config: Config | null;
  /// 登入者的 CAFECA 身分合約地址。**這就是他在本站的 ID，也是帳本上的地址。**
  /// 不再由信箱推導，所以也沒有「這台裝置有沒有鑰匙」這個問題了。
  userId: string | null;
  me: Me;
  wallet: Wallet | null;
  /// 問不到錢包狀態的原因。**這個欄位存在的理由**：以前失敗與「還在問」都是 null，
  /// 畫面只能一直顯示「讀取中」，於是一次暫時性的失敗＝永久卡住。
  walletError: ApiClientError | null;
  refreshWallet: () => void;
  refreshConfig: () => void;

  /// 簽章通道開著嗎。null ＝ 還在問（不要在這時候斷言任何一邊）。
  ///
  /// **這和「有沒有登入」是兩件事**，畫面要分得開：使用者可以登入而不開通道，
  /// 那樣他看得到自己的持倉，但下不了單也送不了交易。兩種狀態需要的下一步不一樣，
  /// 混在一起就會出現「已登入，但每個按鈕按下去都失敗」。
  channelOpen: boolean | null;
  recheckChannel: () => void;

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

  /// 送一筆交易：由**使用者自己的 CAFECA 帳戶**執行，gas 由平台贊助。
  /// 這是每一筆交易的唯一入口，各頁不要自己叫 sendCallsViaChannel。
  relay: (calls: Call[], description: Description) => Promise<{ txHash: `0x${string}`; success: boolean }>;
  /// 請使用者簽一筆 EIP-712（目前用在委託單）。
  signTypedData: (typedData: unknown, description: Description) => Promise<`0x${string}`>;
};
const AccountCtx = createContext<Ctx | null>(null);

function Inner({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  const [config, setConfig] = useState<Config | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [me, setMe] = useState<Me>({ address: null, handle: null, isAdmin: false, isVerifier: false });
  // 身分連同它屬於哪個地址一起存。這樣換帳戶時不必先清空
  //（那是在 effect 裡同步改狀態），對不上就直接當未驗證。
  const [idFor, setIdFor] = useState<{ address: string; identity: Identity; at: number } | null>(null);
  const [walletFor, setWalletFor] = useState<{ userId: string; wallet: Wallet } | null>(null);
  const [walletFail, setWalletFail] = useState<{ userId: string; key: number; error: ApiClientError } | null>(null);
  const [channelFor, setChannelFor] = useState<{ userId: string; open: boolean } | null>(null);

  // config 讀不到時內頁的最後一道判斷（`!config` → 顯示門檻畫面）永遠成立，
  // 畫面就卡在「讀取鏈上設定中…」。所以要能重試。
  const [configKey, refreshConfig] = useReload();
  useEffect(() => {
    const ctl = new AbortController();
    fetchJson<Config>("/api/config", { signal: ctl.signal })
      .then((c) => { if (c) setConfig(c); })
      .catch((e) => { if (e?.name !== "AbortError") console.warn("[config]", e); });
    return () => ctl.abort();
  }, [configKey]);

  useEffect(() => {
    const ctl = new AbortController();
    fetchJson<Me>("/api/me", { signal: ctl.signal })
      // `me` 的型別是非 null，各頁直接讀 `me.isVerifier`。多這一層是因為
      // 一個不該進來的 null 會讓整頁白掉，而白掉比看到舊值難查得多。
      .then((m) => { if (m) setMe(m); })
      .catch((e) => { if (e?.name !== "AbortError") console.warn("[me]", e); });
    return () => ctl.abort();
  }, [userId]);

  const [walletKey, refreshWallet] = useReload();
  useEffect(() => {
    // 沒登入就什麼都不抓。也不需要清空既有狀態：walletFor 連同「這是誰的」一起存，
    // 對不上就當作還沒問到——在 effect 裡同步 setState 正是 React 要擋的東西。
    if (!userId) return;
    const ctl = new AbortController();
    fetchJson<Wallet>("/api/account", { signal: ctl.signal })
      .then((w) => setWalletFor({ userId, wallet: w }))
      .catch((e: ApiClientError) => {
        if (e?.name === "AbortError") return;
        // **重試都用完了才會走到這裡。** 記下來讓畫面說得出話。
        console.warn("[wallet]", e);
        setWalletFail({ userId, key: walletKey, error: e });
      });
    return () => ctl.abort();
  }, [userId, walletKey]);

  const wallet = walletFor?.userId === userId ? walletFor.wallet : null;
  const walletError =
    !wallet && walletFail?.userId === userId && walletFail.key === walletKey ? walletFail.error : null;

  // 通道是**瀏覽器本機的狀態**（id 在 localStorage，私鑰在 IndexedDB），
  // 所以問的是 SDK 不是伺服器。使用者可能在 CAFECA 那邊把它關掉，
  // 而我們只有在下一次請求被拒絕、或重新問一次的時候才會知道。
  const [channelKey, recheckChannel] = useReload();
  useEffect(() => {
    if (!userId) return;
    let ignore = false;
    currentChannel()
      .then((ch) => { if (!ignore) setChannelFor({ userId, open: !!ch }); })
      .catch(() => { if (!ignore) setChannelFor({ userId, open: false }); });
    return () => { ignore = true; };
  }, [userId, channelKey]);
  const channelOpen = channelFor?.userId === userId ? channelFor.open : null;

  const [tierKey, refreshTier] = useReload();
  useEffect(() => {
    const address = wallet?.address;
    if (!address) return;
    let ignore = false;
    (async () => {
      const identity = await fetchJson<Identity>(`/api/kyc?account=${address}`).catch(() => null);
      if (ignore || !identity) return;
      setIdFor({ address, identity, at: Date.now() });
    })();
    return () => { ignore = true; };
  }, [wallet?.address, tierKey]);

  // 身分是**別人**會改的東西：管理員在後台核准、查驗機構核發、主權角色凍結。
  // 這個分頁不會自己知道，所以回到分頁時重抓一次。沒有這一段，使用者得整頁
  // 重新載入才看得到變化，而畫面上不會有任何提示告訴他要這麼做。
  // 通道也一起重問：使用者很可能就是切出去把它關掉的。
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      refreshTier(); refreshWallet(); recheckChannel();
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshTier, refreshWallet, recheckChannel]);

  const mine = idFor && wallet && idFor.address === wallet.address ? idFor : null;
  const identity = mine?.identity ?? null;
  const identityAt = mine?.at ?? 0;
  const tier = !identity || identity.frozen || identity.expiry * 1000 < identityAt ? 0 : identity.tier;

  /// 通道關掉時要換成使用者看得懂的下一步，而不是拋一個 CHANNEL_CLOSED 給他看。
  /// 順便把本機的「通道開著」狀態改對——不然畫面會繼續顯示可以交易。
  const viaChannel = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    setBusy(label);
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "CHANNEL_CLOSED" || msg === "channel_closed") {
        setChannelFor(userId ? { userId, open: false } : null);
        throw new Error(messageFor("channel_closed"));
      }
      throw new Error(messageFor(msg) === "登入沒有完成" ? msg : messageFor(msg));
    } finally {
      setBusy(null);
    }
  }, [userId]);

  // 每一筆交易都走這裡。
  //
  // 和舊版最大的差別：不再需要「送出前確認這個地址上有沒有合約」那一段。
  // 以前錢包是本站部署的 PasskeyAccount，重新部署之後舊地址上就沒有合約了，
  // 而畫面在重新問到之前已經可以按——在那個空窗按下去會拿到一個
  // 使用者沒做錯任何事的錯誤。現在錢包是使用者的 CAFECA 帳戶，
  // 它的存在與本站的部署無關，那個空窗因此不存在。
  const relay = useCallback(
    (calls: Call[], description: Description) =>
      viaChannel(description.title, () => sendCallsViaChannel(calls, description)),
    [viaChannel],
  );

  const signTypedData = useCallback(
    (typedData: unknown, description: Description) =>
      viaChannel(description.title, () => signTypedDataViaChannel(typedData, description)),
    [viaChannel],
  );

  const value = useMemo(
    () => ({
      config, userId, me, wallet, walletError, refreshWallet, refreshConfig,
      channelOpen, recheckChannel,
      identity, identityAt, tier, refreshTier, busy, relay, signTypedData,
    }),
    [
      config, userId, me, wallet, walletError, refreshWallet, refreshConfig,
      channelOpen, recheckChannel,
      identity, identityAt, tier, refreshTier, busy, relay, signTypedData,
    ],
  );
  return <AccountCtx.Provider value={value}>{children}</AccountCtx.Provider>;
}

export function AccountProvider({ children }: { children: React.ReactNode }) {
  return <SessionProvider><Inner>{children}</Inner></SessionProvider>;
}

/// 結算幣在畫面上叫什麼：新台幣（元）。平台上的餘額就是信託專戶裡的新台幣，鏈上的 TWD 只是記帳。
export function useCash(): string {
  return "元";
}

export function useAccount() {
  const ctx = useContext(AccountCtx);
  if (!ctx) throw new Error("useAccount outside provider");
  return ctx;
}
