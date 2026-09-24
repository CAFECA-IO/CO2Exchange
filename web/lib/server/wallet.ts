import "server-only";
import { encodeFunctionData, keccak256, encodeAbiParameters, type Address, type Hex } from "viem";
import { accountFactoryAbi, passkeyAccountAbi } from "@/lib/abis";
import { deployment, publicClient } from "./chain";
import { keysOfRef, pendingOfRef } from "./accounts";
import { accountRef as refOf } from "./account-ref";
import { ApiError } from "./api";

/// 錢包的伺服器端視圖：把「鏈上怎麼樣」與「這台伺服器記得什麼」合成一份答案。
///
/// 職責分得很清楚，因為搞混會出錯：
///   · 鏈  → 哪些金鑰現在有效、帳戶凍結了沒、有沒有進行中的復原提案。
///   · 本機 → keyId ↔ credentialId ↔ 裝置名稱。WebAuthn 要 credentialId，而它不上鏈。
/// 兩邊對不上時以鏈為準：本機多出來的金鑰當作已撤銷，鏈上多出來的當作「別台裝置加的」。

export type WalletKey = {
  keyId: Hex;
  label: string;
  addedAt: number;
  /// 沒有 credentialId 的金鑰＝這台伺服器沒見過它被加進來（別的環境、或復原補上的）。
  /// 仍然是有效金鑰，只是本站無法代為喚起；持有那台裝置的人自己簽得動。
  credentialId?: string;
  publicKey?: Hex;
};

export type WalletView = {
  accountRef: Hex;
  address: Address;
  /// 這個地址上有沒有合約。false ＝ 還沒建立（地址仍然算得出來）。
  exists: boolean;
  frozen: boolean;
  keys: WalletKey[];
  /// 待核准的新裝置。使用者在另一台裝置上登入、建了 passkey，現在等這裡按核准。
  ///
  /// 為什麼要這一步：新裝置自己不能把自己加進來。可以的話，拿到你 Google 帳號的人
  /// 只要登入、建一把自己的 passkey，就直接成為錢包的共同持有人——
  /// 「登入被盜 ≠ 錢包被盜」這句話就不成立了。所以加金鑰一律要現有金鑰簽字。
  /// publicKey 一起帶出來，核准時才編得出 addKey 的 calldata。它本來就是公開值。
  pendingDevices: { keyId: Hex; label: string; requestedAt: number; publicKey: Hex }[];
  /// 進行中的復原提案。有值就代表「有人正在申請把一把新 passkey 加進這個錢包」，
  /// 畫面必須顯眼地問使用者：這是你申請的嗎？
  recovery: { keyId: Hex; label: string; executeAfter: number } | null;
  recoveryDelay: number;
};

export const keyIdOf = (qx: Hex, qy: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [qx, qy]));

/// 64-byte 未壓縮公鑰（x||y）拆成合約要的兩個 bytes32
export function splitPublicKey(publicKey: string): { qx: Hex; qy: Hex } {
  const hex = publicKey.replace(/^0x/, "").replace(/^04/, "");
  if (hex.length !== 128) throw new ApiError("INVALID_PUBLIC_KEY", undefined, { param: "publicKey" });
  return { qx: `0x${hex.slice(0, 64)}` as Hex, qy: `0x${hex.slice(64)}` as Hex };
}

export function addressFor(accountRef: Hex): Promise<Address> {
  return publicClient.readContract({
    address: deployment().accountFactory, abi: accountFactoryAbi, functionName: "getAddress", args: [accountRef],
  });
}

export async function walletOf(email?: string | null, userId?: string | null): Promise<WalletView> {
  const accountRef = refOf(email, userId);
  const address = await addressFor(accountRef);
  const code = await publicClient.getCode({ address });
  const local = keysOfRef(accountRef);
  const byId = new Map(local.map((k) => [k.keyId.toLowerCase(), k]));

  if (!code || code === "0x") {
    return { accountRef, address, exists: false, frozen: false, keys: [], pendingDevices: [], recovery: null, recoveryDelay: 0 };
  }

  const read = (functionName: "frozen" | "keys" | "pendingRecovery" | "RECOVERY_DELAY") =>
    publicClient.readContract({ address, abi: passkeyAccountAbi, functionName });
  const [frozen, onchain, pending, delay] = (await Promise.all([
    read("frozen"), read("keys"), read("pendingRecovery"), read("RECOVERY_DELAY"),
  ])) as [
    boolean,
    readonly [readonly Hex[], readonly { qx: Hex; qy: Hex; label: string; addedAt: bigint; active: boolean }[]],
    readonly [Hex, Hex, string, bigint],
    bigint,
  ];

  const [ids, rows] = onchain;
  const keys: WalletKey[] = ids.map((keyId, i) => {
    const l = byId.get(keyId.toLowerCase());
    return {
      keyId,
      label: rows[i].label || l?.label || "未命名裝置",
      addedAt: Number(rows[i].addedAt),
      credentialId: l?.credentialId,
      publicKey: l?.publicKey,
    };
  });

  // 已經上鏈的就不算「待核准」了——核准成功之後那筆紀錄的 pending 旗標會清掉，
  // 但併發或中斷會留下不一致，所以這裡以鏈為準再濾一次。
  const onChainIds = new Set(ids.map((i) => i.toLowerCase()));
  const pendingDevices = pendingOfRef(accountRef)
    .filter((k) => !onChainIds.has(k.keyId.toLowerCase()))
    .map((k) => ({ keyId: k.keyId, label: k.label, requestedAt: Date.parse(k.createdAt), publicKey: k.publicKey }));

  const [pqx, pqy, plabel, pAfter] = pending;
  return {
    accountRef, address, exists: true, frozen, keys, pendingDevices,
    recovery: Number(pAfter) ? { keyId: keyIdOf(pqx, pqy), label: plabel, executeAfter: Number(pAfter) } : null,
    recoveryDelay: Number(delay),
  };
}

/// 「使用者想做的事」→「要簽的那幾個 call」。
///
/// 為什麼在伺服器端編：這些 calldata 是**帳戶對自己下的指令**，編錯一個位元組
/// 就是一筆會 revert 的交易（或更糟，一筆做了別的事的交易）。ABI 留在伺服器端，
/// 合約改版時不必擔心某個瀏覽器還快取著舊的那一份——這跟 /api/relay/prepare
/// 算 digest 的理由是同一個。
export type Intent =
  | { kind: "addKey"; publicKey: string; label: string }
  | { kind: "removeKey"; keyId: Hex }
  | { kind: "unfreeze" }
  | { kind: "cancelRecovery" };

export function callsFor(address: Address, intent: Intent) {
  const data = (() => {
    switch (intent.kind) {
      case "addKey": {
        const { qx, qy } = splitPublicKey(intent.publicKey);
        return encodeFunctionData({ abi: passkeyAccountAbi, functionName: "addKey", args: [qx, qy, intent.label.slice(0, 64)] });
      }
      case "removeKey":
        return encodeFunctionData({ abi: passkeyAccountAbi, functionName: "removeKey", args: [intent.keyId] });
      case "unfreeze":
        return encodeFunctionData({ abi: passkeyAccountAbi, functionName: "unfreeze" });
      case "cancelRecovery":
        return encodeFunctionData({ abi: passkeyAccountAbi, functionName: "cancelRecovery" });
      default:
        throw new ApiError("UNSUPPORTED_ACTION");
    }
  })();
  return [{ target: address, value: 0n, data }];
}
