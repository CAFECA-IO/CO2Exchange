import "server-only";
import { getAddress, keccak256, toBytes, type Address, type Hex } from "viem";

/// 一個身分 → 一個鏈上錢包地址。這支檔案就是那個「→」。
///
/// 錢包地址是 CREATE2 從 `accountRef` 算出來的，所以 accountRef 一旦決定，
/// 使用者換幾台裝置、配幾把 passkey，地址都不會變。反過來說，**這個函式的輸出
/// 一改，所有人的錢包地址就全部換人**——所以版本前綴寫死在字串裡，
/// 任何調整都必須是新的版本號，而不是就地修改。
///
/// ## v1 → v2：輸入從信箱換成 CAFECA 身分合約地址
///
/// v1 用的是登入信箱。它有一個寫在原本註解裡、當時只能接受的缺陷：
/// 信箱可以被登入供應商重新配發給另一個人（企業網域尤其如此），
/// 那個人登入之後會拿到同一個 accountRef、也就是同一個錢包地址。
///
/// v2 的輸入是使用者的 **CAFECA 身分合約地址**。它是合約地址，不是任何人配發的識別字：
/// 換裝置、換 passkey、以實體卡或備援金鑰恢復之後都不變，也不會被回收再發給別人。
///
/// **這是過渡期的形狀。** 目標是讓 CAFECA 帳戶直接就是使用者在帳本上的地址，
/// 不再經過這一層推導——但那要等 `/trade`、`/retire` 從「使用者自簽鏈上交易」
/// 改走 Bank 資產池之後才能拆，理由見 README 的「身分層」一節。
/// 在那之前，CAFECA 決定「你是誰」，本站的 PasskeyAccount 仍然負責「怎麼簽」。
const PREFIX = "co2x:account:v2:";

export function accountRef(identity: Address): Hex {
  // 一律用 checksum 形式當輸入。大小寫不同的同一個地址必須推出同一個錢包，
  // 否則同一個人從兩條路進來會拿到兩個帳戶——而他只會覺得「我的碳權呢」。
  return keccak256(toBytes(PREFIX + getAddress(identity)));
}

/// 給畫面顯示用的短碼。使用者不需要看到 32 bytes，但在客服對話裡
/// 「我的帳戶參照是 3f9a…c012」比貼一整串好念。
export function shortRef(ref: Hex): string {
  return `${ref.slice(2, 6)}…${ref.slice(-4)}`;
}
