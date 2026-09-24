"use client";
import { createWebAuthnCredential, toWebAuthnAccount } from "viem/account-abstraction";
import { bytesToBigInt, encodeAbiParameters, hexToBytes, type Address, type Hex } from "viem";
import { webAuthnAuthType } from "@/lib/abis";
import { ApiClientError, fetchJson, postJson } from "@/lib/client/fetchJson";

/// 這台裝置上的 passkey。**不是**「我的帳戶」——帳戶在鏈上，地址由登入帳號決定；
/// 這裡只記「這台裝置用哪一把鑰匙、對應鏈上的哪一個 keyId」。
export type StoredCredential = { id: string; publicKey: Hex; address: Address; userId: string; keyId?: Hex };
const KEY = "co2x.credential";

/// ── 憑證儲存：一個可訂閱的小 store ──
///
/// 用 useSyncExternalStore 讀，而不是「先渲染空的、掛載後再用 effect 補上」——
/// 後者每次都多一輪渲染，也正是 React 的 set-state-in-effect 規則要擋的東西。
/// localStorage 本來就是 React 之外的狀態，訂閱它才是對的做法；
/// 附帶好處是另一個分頁登出或改綁時，這個分頁會跟著更新。
///
/// snapshot 必須回穩定的參考（同樣內容要是同一個物件），否則 React 會判定每次都變了
/// 而無限重繪，所以這裡快取解析結果，只有 localStorage 內容真的變了才換新物件。
let snap: { raw: string | null; value: StoredCredential | null } | null = null;
const listeners = new Set<() => void>();

function emit() { for (const l of listeners) l(); }

export function subscribeCredential(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => { listeners.delete(cb); window.removeEventListener("storage", cb); };
}

export function credentialSnapshot(): StoredCredential | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(KEY); } catch { raw = null; }
  if (!snap || snap.raw !== raw) {
    let value: StoredCredential | null = null;
    try { value = raw ? (JSON.parse(raw) as StoredCredential) : null; } catch { value = null; }
    snap = { raw, value };
  }
  return snap.value;
}

/// 伺服器端渲染時沒有 localStorage，一律當作沒有憑證；hydrate 之後才會是真值。
export function credentialServerSnapshot(): StoredCredential | null { return null; }

export function saveCredential(c: StoredCredential) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch {}
  emit();
}
export function clearCredential() {
  try { localStorage.removeItem(KEY); } catch {}
  emit();
}

/// 建立新 passkey（金鑰存在裝置 Keychain / Google 密碼管理員），回傳 64-byte 公鑰
export async function registerPasskey(label: string) {
  const cred = await createWebAuthnCredential({ name: label });
  return { id: cred.id, publicKey: cred.publicKey };
}

/// 用已存在的 passkey 登入（discoverable credential）：只拿得到 credentialId，公鑰與地址向後端查
export async function discoverPasskey(): Promise<string> {
  const assertion = (await navigator.credentials.get({
    publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: "preferred", allowCredentials: [] },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error("沒有選擇 passkey");
  return assertion.id;
}

export type Call = { target: Address; value: bigint; data: Hex };

const wire = (calls: Call[]) => calls.map((c) => ({ ...c, value: c.value.toString() }));

/// 這個地址上有沒有合約——問後端，不是自己連節點。
///
/// 錢包地址是由 factory 以 CREATE2 從 accountRef（登入帳號）推出來的，所以 factory 一換
/// （重新部署、換一條鏈），同一個登入帳號會對到不同地址。localStorage 裡存的舊地址
/// 就成了空地址。呼叫端據此重新建立。
export async function hasCode(address: Address): Promise<boolean> {
  // 問不到是另一回事，別誤判成帳戶不存在——回 true 讓呼叫端照原路走，
  // 真的不存在的話下一步（prepare）會用 WALLET_NOT_DEPLOYED 講清楚。
  return fetchJson<{ exists: boolean }>(`/api/account?address=${address}`)
    .then((d) => !!d.exists)
    .catch(() => true);
}

/// 把一個 digest 交給這台裝置上的 passkey 簽，編成合約要的 WebAuthnAuth。
///
/// 只有**簽章**留在瀏覽器，因為私鑰在裝置的安全元件裡，它非留不可。
async function signDigest(cred: StoredCredential, digest: Hex): Promise<Hex> {
  const account = toWebAuthnAccount({ credential: { id: cred.id, publicKey: cred.publicKey } });
  const { signature, webauthn } = await account.sign({ hash: digest });
  const sigBytes = hexToBytes(signature); // r||s，viem 已將 s 正規化為 low-s
  return encodeAbiParameters([webAuthnAuthType], [{
    authenticatorData: webauthn.authenticatorData,
    clientDataJSON: webauthn.clientDataJSON,
    challengeIndex: BigInt(webauthn.challengeIndex ?? 23),
    typeIndex: BigInt(webauthn.typeIndex ?? 1),
    r: bytesToBigInt(sigBytes.slice(0, 32)),
    s: bytesToBigInt(sigBytes.slice(32, 64)),
  }]);
}

export type RelayResult = { txHash: Hex; status: string; gasUsed: string };

type Prepared = { account: Address; mode: "execute" | "self"; digest: Hex; calls: { target: Address; value: string; data: Hex }[] };

async function prepare(body: unknown, cred: StoredCredential): Promise<Prepared> {
  try {
    return await postJson<Prepared>("/api/relay/prepare", body);
  } catch (e) {
    // 帳戶不在這條鏈上：伺服器用 WALLET_NOT_DEPLOYED 講這件事，不靠狀態碼也不靠訊息字串。
    //
    // 正常路徑不會走到這裡：AccountProvider.relay 在送出前就會確認並重建。
    // 會到這裡表示確認之後帳戶才消失（例如剛好在這中間重新部署），
    // 所以不要再說「重新整理就會自動修好」——那句話在這個時點是空頭支票。
    if (e instanceof ApiClientError && e.code === "WALLET_NOT_DEPLOYED") {
      throw new Error(
        `這個錢包（${cred.address.slice(0, 8)}…）在目前這條鏈上不存在，多半是剛剛重新部署過。` +
          `請重新整理頁面；若仍失敗，按「移除此裝置的紀錄」後用同一個登入帳號重新建立。`,
      );
    }
    throw e;
  }
}

async function send(p: Prepared, keyId: Hex, signature: Hex): Promise<RelayResult> {
  return postJson<RelayResult>("/api/relay", {
    account: p.account, calls: p.calls, keyId, signature, mode: p.mode,
  });
}

/// 後端算 digest → passkey 在這台裝置上簽 → 交給 relayer。
///
/// 要簽什麼、簽完送到哪，都由後端決定：前端不直接跟區塊鏈說話。
/// `account` 由呼叫端明確指定，而且應該是**伺服器回報的**錢包地址，不是
/// localStorage 裡那一個。地址現在由登入帳號決定，伺服器隨時算得出來；
/// 而瀏覽器存的那份只是快取，重新部署之後會過期。以快取為準的話，
/// 使用者會拿到一個他沒做錯任何事、而且重新整理就會消失的錯誤。
export async function signAndRelay(cred: StoredCredential, account: Address, calls: Call[]): Promise<RelayResult> {
  if (!cred.keyId) throw new Error("這台裝置的紀錄不完整（缺少 keyId），請重新整理頁面");
  const p = await prepare({ account, calls: wire(calls) }, cred);
  return send(p, cred.keyId, await signDigest(cred, p.digest));
}

/// 帳戶對自己下的指令：加裝置、撤裝置、解凍、否決復原。
///
/// calldata 由伺服器端編（見 /api/relay/prepare 的 intent），前端只負責簽。
/// 這條路在**凍結期間仍然走得通**——否則掛失會把使用者自己鎖在門外。
export async function signSelfIntent(cred: StoredCredential, intent: Intent): Promise<RelayResult> {
  if (!cred.keyId) throw new Error("這台裝置的紀錄不完整（缺少 keyId），請重新整理頁面");
  const p = await prepare({ intent }, cred);
  return send(p, cred.keyId, await signDigest(cred, p.digest));
}

export type Intent =
  | { kind: "addKey"; publicKey: Hex; label: string }
  | { kind: "removeKey"; keyId: Hex }
  | { kind: "unfreeze" }
  | { kind: "cancelRecovery" };
