import { hashTypedData, type Address, type Hex } from "viem";

/// 「以 CAFECA 登入」要簽的那一串 bytes。
///
/// 獨立一支檔案、**不標 server-only**，是為了它能被單獨測試。
/// 這是整個登入協定唯一不能算錯的地方：算出來的 digest 與錢包簽的那一個
/// 差一個位元組，驗證就永遠不會過；而更危險的方向是**少算了一個欄位**——
/// 那會讓不同的訊息得到同一個 digest，於是一個情境下取得的簽章可以搬到另一個情境用。
///
/// 兩個欄位特別重要，它們是「這個簽章只能用在這裡」的來源：
///   · `message.domain`  —— 要登入的是哪一個網站。仿冒網站簽到的是它自己的網域。
///   · `domain.verifyingContract` —— 哪一個身分合約。換一個帳戶就是完全不同的 digest。

/// CAFECA README 的 SignIn 型別（2026-09 版）：
///   SignIn(string domain, string uri, string nonce, uint256 issuedAt, uint256 expiresAt, string statement, string claims, string channel)
/// `channel` 是後來加上的第八個欄位（登入同時開簽章通道時，錢包把通道資訊放在這裡；沒開就是空字串）。
///
/// 少了它，算出來的 digest 就和錢包簽的那一個不同，而錯誤只會是「身分合約不承認這個簽章」——
/// 那正是 2026-09-28 登入失敗的原因。舊版錢包的回應沒有 `channel` 欄位時，照舊用七個欄位算。
export const SIGNIN_TYPES = {
  SignIn: [
    { name: "domain", type: "string" },
    { name: "uri", type: "string" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "statement", type: "string" },
    { name: "claims", type: "string" },
    { name: "channel", type: "string" },
  ],
} as const;

/// 沒有 `channel` 的舊版（錢包端改版前）
export const SIGNIN_TYPES_V1_LEGACY = {
  SignIn: [
    { name: "domain", type: "string" },
    { name: "uri", type: "string" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "statement", type: "string" },
    { name: "claims", type: "string" },
  ],
} as const;

export type SignInMessage = {
  domain: string;
  uri: string;
  nonce: string;
  /// Unix 秒。以 bigint 進雜湊——協定的型別是 uint256，而 number 只是「現在剛好放得下」。
  issuedAt: bigint;
  expiresAt: bigint;
  statement: string;
  claims: string;
  /// 回應的 message 裡有這個欄位就一定要給（空字串也是值）；沒有這個欄位才是舊版。
  channel?: string;
};

export function signInDigest(chainId: number, account: Address, message: SignInMessage): Hex {
  const domain = { name: "CAFECA Sign-In", version: "1", chainId, verifyingContract: account } as const;
  if (message.channel === undefined) {
    const { channel: _c, ...legacy } = message;
    void _c;
    return hashTypedData({ domain, types: SIGNIN_TYPES_V1_LEGACY, primaryType: "SignIn", message: legacy });
  }
  return hashTypedData({ domain, types: SIGNIN_TYPES, primaryType: "SignIn", message: { ...message, channel: message.channel } });
}
