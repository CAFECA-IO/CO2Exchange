import { keccak256, toBytes, type Hex } from "viem";

/// 開發用登入的代號 → 私鑰。帳戶地址就是這把私鑰的地址，所以開發帳戶**真的簽得出**帳本事件，
/// 查核工具照樣驗得過（見 lib/server/ledger/write.ts 的 devSignerFor）。
///
/// 這把私鑰從代號就推得出來——任何人都能算，所以它只能出現在本機測試鏈上。
export const devKeyOf = (label: string): Hex => keccak256(toBytes(`co2x:dev:${label.toLowerCase()}`));
