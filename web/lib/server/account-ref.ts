import "server-only";
import { keccak256, toBytes, type Hex } from "viem";

/// 一個登入帳號 → 一個鏈上錢包地址。這支檔案就是那個「→」。
///
/// 錢包地址是 CREATE2 從 `accountRef` 算出來的，所以 accountRef 一旦決定，
/// 使用者換幾台裝置、配幾把 passkey，地址都不會變。反過來說，**這個函式的輸出
/// 一改，所有人的錢包地址就全部換人**——所以版本前綴寫死在字串裡，
/// 任何調整都必須是新的版本號，而不是就地修改。
const PREFIX = "co2x:account:v1:";

/// 為什麼用 email 而不是 userId：userId 由登入供應商決定，同一個人用 Google 登入
/// 與用開發用登入會拿到兩組不同的 id，於是變成兩個錢包——而使用者只覺得
/// 「我登入了，我的碳權呢」。這個系統其他地方（ADMIN_EMAILS、VERIFIER_EMAILS、
/// KYC 紀錄）本來就以 email 認人，這裡跟著一致。
///
/// 代價寫清楚：email 可以被登入供應商重新配發給另一個人（企業網域尤其如此），
/// 那個人登入之後會拿到同一個 accountRef、也就是同一個錢包地址——但**進不去**，
/// 因為錢包裡的 passkey 不是他的，而加金鑰要現有金鑰簽章。他看得到餘額，
/// 動不了任何一分錢，也不能發動復原（那要治理方重新驗身分）。
/// 正式環境應改用供應商的 `sub`（不可重複配發），並在 KYC 時把它與身分證字號綁定。
export function accountRef(email?: string | null, userId?: string | null): Hex {
  const key = email?.trim().toLowerCase() || userId;
  if (!key) throw new Error("no identity");
  return keccak256(toBytes(PREFIX + key));
}

/// 給畫面顯示用的短碼。使用者不需要看到 32 bytes，但在客服對話裡
/// 「我的帳戶參照是 3f9a…c012」比貼一整串好念。
export function shortRef(ref: Hex): string {
  return `${ref.slice(2, 6)}…${ref.slice(-4)}`;
}
