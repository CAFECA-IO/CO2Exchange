import "server-only";
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  type Abi,
  type Hex,
} from "viem";
import { errorAbi } from "@/lib/error-abi";

/// 把鏈上的 revert 拆到看得懂為止。
///
/// 這份程式碼原本只長在 /api/relay 裡，因為「送出交易被拒絕」是它的日常。
/// 但 revert 不只發生在寫入：讀取也會 revert，而那時候沒有人在拆——
/// 於是它一路掉到 handleError 的最後一行，印出「未分類的例外」加一頁 viem 堆疊，
/// 使用者拿到的是 INTERNAL。**任何錯誤都要有制式錯誤碼**，這裡是補上那個缺口。
///
/// 鏈上的錯誤是一層包一層的，而且不只一層：
///
///   PasskeyAccount.CallFailed(index, reason)      ← 哪一個動作失敗
///     └─ v4 PoolManager.WrappedError(target, selector, reason, details)
///          └─ CarbonKYCHook 擋下來 → NotActiveAccount(0x…)   ← 真正的原因
///          └─ details: HookCallFailed()
///
/// 只拆一層的話，使用者看到的是
/// `WrappedError(0xe447…, 0x575e24b4, 0xacf9e90a000…, 0xa9e35b2f)`——
/// 比原本的四個位元組好一點，但還是要自己去查 selector 才知道發生什麼事。
/// 所以這裡遞迴：任何一個 bytes 參數只要解得開就繼續往裡面拆。
const MAX_DEPTH = 6;

/// 使用者真的會遇到的那幾個，給一句下一步。其餘的照原樣顯示就好——
/// 硬要為每一個 error 編一句話，只會讓真正有用的那幾句被淹沒。
const HINT: Record<string, string> = {
  NotActiveAccount: "這個帳戶在目前這條鏈上沒有有效的身分驗證。鏈重開或重新部署之後要重做一次 /kyc（KYC_AUTO_APPROVE=1 的話是即時的）。",
  IdentityExpired: "身分驗證過期了，到 /kyc 重新申請。",
  AccountFrozen: "這個錢包被凍結了。到「裝置與安全」用任何一把還在手上的 passkey 解凍；一把都不剩的話走復原程序。",
  UnknownKey: "這把 passkey 已經從錢包裡移除了（或從來沒加進去）。換一台還在清單裡的裝置操作。",
  KeyAlreadyExists: "這把 passkey 已經在錢包裡了，不需要再加一次。",
  LastKey: "這是最後一把 passkey，移除它會讓錢包永遠動不了。先加一台新裝置，再撤掉舊的。",
  NotSelf: "這個操作只能由錢包自己發動，也就是要有一把現存 passkey 簽字。",
  NotRecoveryAgent: "復原提案只有治理方能提出，而且要重新通過身分驗證。",
  NoPendingRecovery: "目前沒有進行中的復原提案。",
  RecoveryNotReady: "復原提案還在等待期內。等待期存在的理由就是讓你有時間否決它。",
  RecoveryPending: "已經有一個進行中的復原提案，先完成或否決它。",
  OrderInactive: "這張單已經被買走或取消了。模擬器在跑的時候很容易遇到——它假設自己是鏈上唯一的寫入者，掛單簿在它的記憶體裡。重新整理掛單簿再試。",
  ExceedsRemaining: "掛單剩餘量不足，多半是同一張單剛被別人吃掉（模擬器在跑的話尤其常見）。",
  PurposeNotAllowed: "這個轄區的額度不允許這個註銷用途。國外額度只能扣碳費或做自願性碳中和。",
  ERC20InsufficientBalance: "結算幣不夠。到 /trade 按「領取測試用 mTWD」。",
  ERC20InsufficientAllowance: "結算幣的授權額度不夠，重新送一次會一併補上授權。",
};

function describe(data: Hex, depth = 0): string | null {
  if (depth > MAX_DEPTH || !data || data === "0x") return null;
  let d;
  try {
    d = decodeErrorResult({ abi: errorAbi as unknown as Abi, data });
  } catch {
    return null;
  }
  const args = d.args ?? [];
  // 參數裡只要有解得開的 bytes，那一層就是信封，真正的原因在裡面
  for (const a of args) {
    if (typeof a === "string" && a.startsWith("0x") && a.length > 10) {
      const inner = describe(a as Hex, depth + 1);
      if (inner) return inner;
    }
  }
  const name = d.errorName;
  const shown = args.length ? `${name}(${args.map(String).join(", ")})` : name;
  return HINT[name] ? `${shown} — ${HINT[name]}` : shown;
}

/// 把 `CallFailed(index, reason)` 這一層翻成「第 N 個動作失敗：<真正的原因>」。
export function explainRevert(errorName: string, args: readonly unknown[]): string {
  if (errorName !== "CallFailed") {
    const shown = args.length ? `${errorName}(${args.map(String).join(", ")})` : errorName;
    return HINT[errorName] ? `${shown} — ${HINT[errorName]}` : shown;
  }
  const [index, reason] = args as [bigint, Hex];
  const at = `第 ${Number(index) + 1} 個動作`;
  if (!reason || reason === "0x") return `${at}失敗，合約沒有給原因（多半是 require 沒帶訊息，或 gas 不足）`;
  const inner = describe(reason);
  return inner
    ? `${at}失敗：${inner}`
    : `${at}失敗：${reason.slice(0, 10)}（沒有對應的 error 定義，可能是合約改過但 lib/error-abi.ts 沒重新產生）`;
}

export type RevertInfo = {
  /// 有解出 error 名稱才有值。空的 revert（`raw: "0x"`）沒有名字可給。
  errorName?: string;
  /// 這一筆 revert 發生在哪個合約上。用來判斷是不是部署檔對不上。
  contractAddress?: string;
  functionName?: string;
  /// 給人看的一句話。
  message: string;
  /// revert 了，但沒有帶任何資料。
  empty: boolean;
  /// 這是一個唯讀呼叫（view / pure）。
  ///
  /// 這個旗標決定「空的 revert」該怎麼解讀，而那個差別很重要：
  ///   · **唯讀**函式空手 revert —— 本專案的 view 沒有一個會 revert，所以這幾乎
  ///     一定是「那個地址上的合約不是我們以為的那一個」（選擇器對不上 → fallback）。
  ///   · **寫入**函式空手 revert —— 太常見了：沒帶訊息的 require、gas 不足、
  ///     estimateGas 拿不到 revert data。斷言成「部署檔對不上」會給出一個
  ///     **有自信而且錯的**診斷，那比講不清楚更糟：它會讓人去重新部署，
  ///     而真正的原因（例如 attestation 過期）原封不動。
  ///
  /// 這一條是實際踩到才加的：一次 attestation 過期被說成「kycRegistry 上的合約
  /// 沒有 register」，而地址其實完全正確。
  isRead: boolean;
};

/// 這個函式在 ABI 裡是不是唯讀的。
function isReadOnly(abi: unknown, functionName?: string): boolean {
  if (!Array.isArray(abi) || !functionName) return false;
  const item = abi.find(
    (x) => typeof x === "object" && x !== null && (x as { name?: string }).name === functionName,
  ) as { stateMutability?: string } | undefined;
  return item?.stateMutability === "view" || item?.stateMutability === "pure";
}

/// 從任何一個丟出來的東西裡找出 revert。不是 revert 就回 null。
export function decodeRevert(e: unknown): RevertInfo | null {
  if (!(e instanceof BaseError)) return null;
  const exec = e.walk((x) => x instanceof ContractFunctionExecutionError) as ContractFunctionExecutionError | null;
  const where = {
    contractAddress: exec?.contractAddress,
    functionName: exec?.functionName,
    isRead: isReadOnly(exec?.abi, exec?.functionName),
  };

  const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!r) return null;

  if (r.data) {
    return { ...where, errorName: r.data.errorName, message: explainRevert(r.data.errorName, r.data.args ?? []), empty: false };
  }
  // 解不開：可能是 require 沒帶訊息，也可能是**那個地址上的合約根本不是我們以為的那一個**
  // （選擇器對不上 → fallback revert，而且沒有資料）。判斷交給呼叫端，這裡只報事實。
  const reason = r.reason && r.reason !== "execution reverted" ? r.reason : undefined;
  return {
    ...where,
    message: reason ?? "合約拒絕了這個操作，而且沒有說明原因（多半是沒帶訊息的 require，或條件在送出前就變了）",
    empty: !reason,
  };
}
