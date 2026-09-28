import { encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { mnemonicToAccount, type LocalAccount } from "viem/accounts";
import { LEDGER_ABI, PROOF_ABI } from "./chain.ts";

/// 新台幣入出金（規則第 4 版）。
///
/// 使用者的錢是真的新台幣，在信託專戶裡；鏈上只有記帳用的 `LedgerTWD`，唯一持有人是帳本合約。
/// 兩個動作都由**營運 Safe** 在鏈上確認（Ledger.creditDeposit／settleWithdrawal 是 OPERATOR_ROLE）：
///
///   · 入金：使用者用自己的「入金識別碼」匯款到信託專戶 → 營運方對帳 → 營運 Safe 呼叫
///     `creditDeposit(帳戶, 金額, bankRef)` → 帳本鏡像成 cashDeposit。
///   · 出金：使用者簽出金請求（帶收款帳戶的雜湊）→ 下一期承諾上鏈 → 營運方匯款 → 營運 Safe 呼叫
///     `settleWithdrawal(帳戶, 金額, bankRef, 證據)` → 帳本鏡像成 cashWithdraw。
///
/// `bankRef` 是銀行交易參考號的雜湊。明文留在營運方與信託銀行；同一個參考號合約不收第二次。
///
/// 這支檔案不依賴 Next：網站（只在本機鏈）、營運工具 `npm run fiat`、做市、模擬器、測試共用。

export const SAFE_ABI = parseAbi([
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/// 銀行交易參考號 → 鏈上的 bankRef。前綴讓入金與出金不可能撞在一起。
export const bankRefOf = (kind: "in" | "out", ref: string): Hex => {
  const r = ref.trim();
  if (!r) throw new Error("銀行交易參考號不能是空的");
  return keccak256(toBytes(`co2x:bank:${kind}:${r}`));
};

/// 收款帳戶 → 出金請求裡的 payoutRef。加鹽：帳本公開的只是雜湊，沒有鹽的話銀行帳號可以逐一試出來。
export function payoutRefOf(p: { bankCode: string; accountNo: string; holder: string }, salt: string): Hex {
  const norm = `${p.bankCode.trim()}|${p.accountNo.replace(/[\s-]/g, "")}|${p.holder.trim()}`;
  return keccak256(toBytes(`co2x:payout:${norm}:${salt}`));
}

/// 入金識別碼：使用者匯款時填在備註（正式營運換成信託銀行發的虛擬帳號）。由帳戶地址決定，
/// 所以營運方對帳時看得出這筆錢是誰的，而且不必另外存一張對照表。10 位數字。
export function depositCodeOf(account: Address): string {
  const n = BigInt(keccak256(toBytes(`co2x:deposit:${account.toLowerCase()}`))) % 10n ** 10n;
  return n.toString().padStart(10, "0");
}

export function creditDepositCall(ledger: Address, account: Address, amount: bigint, bankRef: Hex) {
  return { to: ledger, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: "creditDeposit", args: [account, amount, bankRef] }) };
}

export type BalanceProofArgs = {
  proofEpoch: bigint; assetsRoot: Hex; leafKg: bigint; leafCash: bigint; leafRequested: bigint; leafSettled: bigint;
  siblings: { hash: Hex; kg: bigint; cash: bigint }[]; path: bigint;
};

export function settleWithdrawalCall(ledger: Address, account: Address, amount: bigint, bankRef: Hex, proof: BalanceProofArgs) {
  return { to: ledger, data: encodeFunctionData({ abi: PROOF_ABI, functionName: "settleWithdrawal", args: [account, amount, bankRef, proof] }) };
}

/// 本機部署（DeployLedger 的預設）營運 Safe 的兩位持有人：anvil 助記詞第 8、9 個帳戶。
/// **只在本機鏈上用**——那兩把私鑰是公開的，外部鏈的部署腳本會拒絕它們。
export const localOperatorOwners = (): LocalAccount[] =>
  [8, 9].map((i) => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: i }));

/// 營運 Safe 執行一筆呼叫：收齊門檻數量的持有人簽章（ECDSA 直接簽 safeTxHash，v = 27/28），
/// 依地址排序後由 sender 送出 execTransaction（sender 只付 gas，不需要是持有人）。
export async function execOperatorSafe(o: {
  pub: PublicClient; sender: WalletClient; safe: Address; to: Address; data: Hex; owners: LocalAccount[];
}): Promise<Hex> {
  const [nonce, threshold, onchainOwners] = await Promise.all([
    o.pub.readContract({ address: o.safe, abi: SAFE_ABI, functionName: "nonce" }),
    o.pub.readContract({ address: o.safe, abi: SAFE_ABI, functionName: "getThreshold" }),
    o.pub.readContract({ address: o.safe, abi: SAFE_ABI, functionName: "getOwners" }),
  ]);
  const isOwner = new Set(onchainOwners.map((a) => a.toLowerCase()));
  const signers = o.owners.filter((a) => isOwner.has(a.address.toLowerCase()));
  if (BigInt(signers.length) < threshold) {
    throw new Error(`營運 Safe 要 ${threshold} 位持有人簽章，手上只有 ${signers.length} 位是持有人（${o.owners.map((a) => a.address).join(", ") || "沒有"}）`);
  }
  const hash = await o.pub.readContract({
    address: o.safe, abi: SAFE_ABI, functionName: "getTransactionHash",
    args: [o.to, 0n, o.data, 0, 0n, 0n, 0n, ZERO, ZERO, nonce],
  });
  const chosen = signers.slice(0, Number(threshold)).sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));
  const sigs = await Promise.all(chosen.map((a) => a.sign!({ hash })));
  const signatures = `0x${sigs.map((s) => s.slice(2)).join("")}` as Hex;
  const tx = await o.sender.writeContract({
    address: o.safe, abi: SAFE_ABI, functionName: "execTransaction",
    args: [o.to, 0n, o.data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures],
    account: o.sender.account!, chain: o.sender.chain,
  });
  const r = await o.pub.waitForTransactionReceipt({ hash: tx });
  if (r.status !== "success") throw new Error(`營運 Safe 的交易失敗：${tx}`);
  // Safe 內層呼叫失敗時 execTransaction 本身不 revert，而是發 ExecutionFailure；用 nonce 沒前進以外的方式確認
  const failed = r.logs.some((l) => l.address.toLowerCase() === o.safe.toLowerCase() && l.topics[0] === "0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23");
  if (failed) throw new Error(`營運 Safe 執行了，但帳本合約拒絕了這筆呼叫：${tx}`);
  return tx;
}
