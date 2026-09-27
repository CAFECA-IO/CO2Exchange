import { hashTypedData, type Address, type Hex } from "viem";

/// 委託單的 EIP-712 型別。**使用者簽的就是這個。**
///
/// 這個檔案和 `log.ts` 一樣**不依賴 Next、不用路徑別名**，理由也一樣：
/// 查核機構、監理機關、以及任何想自己驗一次簽章的人，都要跑得動它。
/// 「這張單確實是這個帳戶下的」如果只有交易所驗得出來，那就不是證據。
///
/// ## 為什麼是 EIP-712，不是簽 log.ts 的正規化位元組
///
/// log 的正規化編碼（ABI + 版本 + 種類）是為了**雜湊鏈**服務的：它要涵蓋所有事件
/// 種類、要帶序號、要能接成一條鏈。而序號是交易所給的——使用者下單的當下並不知道
/// 自己會被排在第幾號，所以他不可能簽一個含序號的結構。
///
/// 兩者職責不同，欄位也就不同：
///   · **使用者簽的**是他的意思表示：我、哪一批、多少、什麼價、到什麼時候、第幾號 nonce。
///   · **log 記的**是那份意思表示加上交易所給它的位置（seq）與收到的時間（at）。
///
/// 所以簽章驗的是前者。後者對不上時，使用者手上的簽收收據才是武器。
///
/// ## 錢包端的限制（不是我們能關掉的）
///
/// CAFECA 錢包會拒絕 `verifyingContract` 指向使用者自己的帳戶、EntryPoint 或
/// CAFECA 系統合約的 EIP-712 訊息，也拒絕網域名稱是 `CAFECA Sign-In` / `ERC4337` 的——
/// 那是防止網站借簽章通道偽造登入或帳戶操作。
///
/// 我們把 `verifyingContract` 指向 **Bank**：它既不是那幾類合約，語意上也對——
/// 這張單是對這個資產池下的，換一個池子就是不同的簽章。
/// 同樣地 `chainId` 進網域，所以測試網簽的單搬不到主網。

export const ORDER_DOMAIN_NAME = "TideBit-DeFi Carbon Exchange";
export const ORDER_DOMAIN_VERSION = "1";

export const ORDER_TYPES = {
  PlaceOrder: [
    { name: "account", type: "address" },
    { name: "side", type: "string" },
    { name: "batchId", type: "uint256" },
    { name: "country", type: "string" },
    { name: "amountKg", type: "uint256" },
    { name: "pricePerTonne", type: "uint256" },
    { name: "minFillKg", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const CANCEL_TYPES = {
  CancelOrder: [
    { name: "account", type: "address" },
    { name: "orderSeq", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/// 數值一律用**十進位字串**，不用 bigint。
///
/// 兩個理由，都是實務上的：簽章請求要經過 JSON 送到錢包，而 JSON 沒有 bigint
/// （CAFECA 的文件也明說不要傳 bigint）；而且字串在兩端不會因為
/// 「某一邊不小心當成 number」而在 2^53 之後靜靜地算出不同的 digest。
/// viem 的 `hashTypedData` 對 uint 欄位接受十進位字串，值一樣就是同一個 digest。
export type PlaceOrderMessage = {
  account: Address;
  side: "buy" | "sell";
  batchId: string;
  country: string;
  amountKg: string;
  pricePerTonne: string;
  minFillKg: string;
  expiry: string;
  nonce: string;
};

export type CancelOrderMessage = {
  account: Address;
  orderSeq: string;
  nonce: string;
};

const domain = (chainId: number, bank: Address) => ({
  name: ORDER_DOMAIN_NAME,
  version: ORDER_DOMAIN_VERSION,
  chainId,
  verifyingContract: bank,
});

/// 交給錢包簽的那一包。前端與後端**必須用同一個函式產生它**——
/// 兩邊各組一份是這類協定最常見的壞法：欄位順序差一個、型別寫成 uint128，
/// digest 就不一樣，而錯誤訊息只會說「簽章無效」。
export function placeTypedData(chainId: number, bank: Address, message: PlaceOrderMessage) {
  return { domain: domain(chainId, bank), types: ORDER_TYPES, primaryType: "PlaceOrder" as const, message };
}

export function cancelTypedData(chainId: number, bank: Address, message: CancelOrderMessage) {
  return { domain: domain(chainId, bank), types: CANCEL_TYPES, primaryType: "CancelOrder" as const, message };
}

/// 算 digest 時把十進位字串轉回 bigint。
///
/// 線上傳的是字串（JSON 沒有 bigint，錢包也要求字串），但 EIP-712 編的是**值**：
/// 任何正確的實作把 "123" 當成 uint256 的 123，所以兩邊得到同一個 digest。
/// 這裡轉一次而不是依賴 viem 對字串的寬容，是因為「剛好能跑」和「型別上就對」
/// 在這種地方差很多——這是整個委託單不可否認性的根。
const nums = <T extends Record<string, unknown>>(m: T, keys: readonly (keyof T)[]) => {
  const out: Record<string, unknown> = { ...m };
  for (const k of keys) out[k as string] = BigInt(String(m[k]));
  return out;
};

export const placeDigest = (chainId: number, bank: Address, m: PlaceOrderMessage): Hex =>
  hashTypedData({
    ...placeTypedData(chainId, bank, m),
    message: nums(m, ["batchId", "amountKg", "pricePerTonne", "minFillKg", "expiry", "nonce"]),
  } as Parameters<typeof hashTypedData>[0]);

export const cancelDigest = (chainId: number, bank: Address, m: CancelOrderMessage): Hex =>
  hashTypedData({
    ...cancelTypedData(chainId, bank, m),
    message: nums(m, ["orderSeq", "nonce"]),
  } as Parameters<typeof hashTypedData>[0]);

/// log 裡的 `place` 事件 → 當初被簽的那則訊息。
///
/// 重播與爭議處理都要用它：拿 log 裡的欄位重建訊息、算 digest、
/// 回到鏈上問帳戶合約「這個簽章是你簽的嗎」。**欄位只能從 log 取**——
/// 任何從別處補進來的預設值都會讓 digest 變成算不回去的。
export function placeMessageOf(e: {
  account: Address; side: "buy" | "sell"; batchId: bigint; country: string;
  amountKg: bigint; pricePerTonne: bigint; minFillKg: bigint; expiry: bigint; nonce: bigint;
}): PlaceOrderMessage {
  return {
    account: e.account,
    side: e.side,
    batchId: e.batchId.toString(),
    country: e.country,
    amountKg: e.amountKg.toString(),
    pricePerTonne: e.pricePerTonne.toString(),
    minFillKg: e.minFillKg.toString(),
    expiry: e.expiry.toString(),
    nonce: e.nonce.toString(),
  };
}

export function cancelMessageOf(e: { account: Address; orderSeq: bigint; nonce: bigint }): CancelOrderMessage {
  return { account: e.account, orderSeq: e.orderSeq.toString(), nonce: e.nonce.toString() };
}
