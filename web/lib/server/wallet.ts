import "server-only";
import { parseAbi, type Address } from "viem";
import { publicClient } from "./chain";
import { cafecaConfig, identityClient, WALLET_ORIGIN } from "./cafeca/config";
import { readKycStatus, type KycStatus } from "@/lib/ledger/cafeca-identity";

/// 錢包的伺服器端視圖。
///
/// 這支檔案在改用 CAFECA 之後**大幅縮小**，而縮小本身就是這次改動的重點。
///
/// 以前它要把兩邊合成一份答案：鏈上的（哪些金鑰有效、凍結了沒、有沒有復原提案）
/// 與本機的（keyId ↔ credentialId ↔ 裝置名稱），因為錢包是我們自己部署的
/// `PasskeyAccount`，金鑰生命週期歸我們管。連帶地，本機要存一份
/// 「哪一台裝置屬於哪個人」的對照——那份資料連同它的個資風險，現在一起消失了。
///
/// 現在錢包是使用者的 CAFECA 身分合約。加裝置、撤金鑰、以實體卡恢復，
/// 全部在 CAFECA 錢包裡做。這是好事：那些是身分層最敏感的操作，
/// 而本站是一個交易所，不該有能力碰它們。於是這裡只剩三個問題：
///
///   · 這個地址上有合約嗎（ERC-4337 帳戶在第一次動作前可能還沒部署）
///   · 它現在正在恢復中嗎（有人正在主張這個帳戶是他的）
///   · 它的實名等級是多少（決定 KYCRegistry 的 tier）

const recoveryAbi = parseAbi(["function isPending(address) view returns (bool)"]);

export type WalletView = {
  address: Address;
  exists: boolean;
  recoveryPending: boolean;
  kycLevel: number;
  /// IdentityRegistry v2 的完整狀態（主體類型、簽章者等級）。沒有設定 v2 或讀不到時為 null
  kyc: KycStatus | null;
  /// 使用者要管理金鑰、裝置或發動恢復時該去的地方。
  manageUrl: string;
};

export async function walletOf(address: Address): Promise<WalletView> {
  const cfg = await cafecaConfig();
  const { client } = await identityClient();

  const registry = cfg.contracts.identityRegistry;
  const [code, recoveryPending, kyc] = await Promise.all([
    client.getCode({ address }).catch(() => undefined),
    client
      .readContract({ address: cfg.contracts.recovery, abi: recoveryAbi, functionName: "isPending", args: [address] })
      .catch(() => false),
    // 只讀 v2（v1 不能撤銷、舊簽章可重送）。讀不到就當未實名：寧可把人擋在門外，也不要因為一次 RPC 失敗就把未實名當成已實名。
    registry ? readKycStatus((q) => client.readContract(q as never), registry, address).catch(() => null) : Promise.resolve(null),
  ]);

  return {
    address,
    exists: Boolean(code && code !== "0x"),
    recoveryPending: Boolean(recoveryPending),
    kycLevel: kyc?.effectiveLevel ?? 0,
    kyc,
    manageUrl: `${WALLET_ORIGIN}/security`,
  };
}

/// 開發用登入的帳戶：沒有 CAFECA 身分合約，也沒有恢復流程。實名等級照 session（開發登入給的）。
export async function devWalletOf(address: Address, kycLevel: number): Promise<WalletView> {
  return { address, exists: await existsHere(address), recoveryPending: false, kycLevel, kyc: null, manageUrl: `${WALLET_ORIGIN}/security` };
}

/// 這個地址在**本站這條鏈**上有沒有合約。
///
/// 與上面那個 `exists` 不同：身分合約在 CAFECA 那條鏈上，資產在本站這條鏈上。
/// 兩者同鏈時（應有的設定）答案一樣；不同鏈時就不一樣，而那個差異正是
/// 「這個人的身分驗得過，但他在這條鏈上還不能收東西」的情況。
export async function existsHere(address: Address): Promise<boolean> {
  const code = await publicClient.getCode({ address }).catch(() => undefined);
  return Boolean(code && code !== "0x");
}
