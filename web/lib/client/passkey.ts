"use client";
import { createWebAuthnCredential, toWebAuthnAccount } from "viem/account-abstraction";
import { bytesToBigInt, encodeAbiParameters, hexToBytes, type Address, type Hex } from "viem";
import { passkeyAccountAbi, webAuthnAuthType } from "@/lib/abis";
import { createPublicClient, http } from "viem";

export type StoredCredential = { id: string; publicKey: Hex; address: Address; userId: string };
const KEY = "co2x.credential";

export function loadCredential(userId: string): StoredCredential | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as StoredCredential;
    return c.userId === userId ? c : null;
  } catch { return null; }
}
export function saveCredential(c: StoredCredential) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch {} }
export function clearCredential() { try { localStorage.removeItem(KEY); } catch {} }

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

/// 這個地址上有沒有合約。
///
/// PasskeyAccount 的地址是由 factory 以 CREATE2 從公鑰推出來的，所以 factory 一換
/// （重新部署、換一條鏈），同一把 passkey 會對到不同地址。localStorage 裡存的舊地址
/// 就成了空地址，任何 read 都回 "0x"。呼叫端據此重新綁定。
export async function hasCode(rpcUrl: string, address: Address): Promise<boolean> {
  try {
    const code = await createPublicClient({ transport: http(rpcUrl) }).getCode({ address });
    return !!code && code !== "0x";
  } catch {
    return true; // 連不上節點是另一回事，別誤判成帳戶不存在
  }
}

/// 讀鏈上 digest → passkey 簽 → 編成合約要的 WebAuthnAuth → 交給 relayer
export async function signAndRelay(rpcUrl: string, cred: StoredCredential, calls: Call[]) {
  const client = createPublicClient({ transport: http(rpcUrl) });
  if (!(await hasCode(rpcUrl, cred.address))) {
    throw new Error(
      `這個裝置記住的帳戶（${cred.address.slice(0, 8)}…）在目前這條鏈上不存在，` +
        `多半是合約重新部署過。重新整理頁面會自動用同一把 passkey 重新綁定；若仍失敗，請按「移除此裝置的帳戶紀錄」後重新建立。`,
    );
  }
  const nonce = await client.readContract({ address: cred.address, abi: passkeyAccountAbi, functionName: "nonce" });
  const digest = await client.readContract({ address: cred.address, abi: passkeyAccountAbi, functionName: "getDigest", args: [calls, nonce] });

  const account = toWebAuthnAccount({ credential: { id: cred.id, publicKey: cred.publicKey } });
  const { signature, webauthn } = await account.sign({ hash: digest });
  const sigBytes = hexToBytes(signature); // r||s，ox 已將 s 正規化為 low-s
  const r = bytesToBigInt(sigBytes.slice(0, 32));
  const s = bytesToBigInt(sigBytes.slice(32, 64));
  const encoded = encodeAbiParameters([webAuthnAuthType], [{
    authenticatorData: webauthn.authenticatorData,
    clientDataJSON: webauthn.clientDataJSON,
    challengeIndex: BigInt(webauthn.challengeIndex ?? 23),
    typeIndex: BigInt(webauthn.typeIndex ?? 1),
    r, s,
  }]);

  const res = await fetch("/api/relay", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: cred.address, calls: calls.map((c) => ({ ...c, value: c.value.toString() })), signature: encoded }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "relay failed");
  return json as { txHash: Hex; status: string; gasUsed: string };
}
