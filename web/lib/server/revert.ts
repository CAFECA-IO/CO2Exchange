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
/// 設計 v4 之後鏈上只剩帳本合約、結算幣與治理，會 revert 的地方少了很多：
/// 存入（結算幣授權或餘額不夠）、提領與領回（證據過期、已經領完、提領關閉）、
/// 承諾（期別或雜湊鏈接不上、償付不足）。讀取也可能 revert，那時候一樣要翻成人話——
/// **任何錯誤都要有制式錯誤碼**，不能掉到 handleError 的最後一行變成 INTERNAL。
///
/// 錯誤可能一層包一層（例如 Safe 或 Timelock 轉發的呼叫把原因放在 bytes 參數裡），
/// 所以這裡遞迴：任何一個 bytes 參數只要解得開就繼續往裡面拆。
const MAX_DEPTH = 6;

/// 使用者真的會遇到的那幾個，給一句下一步。其餘的照原樣顯示就好——
/// 硬要為每一個 error 編一句話，只會讓真正有用的那幾句被淹沒。
const HINT: Record<string, string> = {
  NotLatestEpoch: "證據不是最新一期的。重新整理提領狀態，用最新一期的證據再送一次。",
  UnknownEpoch: "這一期還沒有承諾上鏈。等下一期承諾（最長一小時）再領。",
  BadProof: "證據對不上鏈上的承諾。多半是承諾剛換期，重新整理後用最新的證據再送。",
  SumMismatch: "證據裡的加總對不上鏈上的承諾，這份證據不是這一期產的。",
  NothingLeft: "這個帳戶在這一期沒有可以領的了（已經領完，或還沒有提領請求）。",
  WithdrawalsDisabled: "一般提領目前關閉（營運 Safe 的開關）。承諾停擺超過 72 小時之後，逃生提領不受這個開關影響。",
  Insolvent: "帳本宣稱欠使用者的結算幣比合約持有的多，合約拒絕了這一期承諾。這是要立刻查的事。",
  ChainBroken: "承諾的 prev 接不上上一期。承諾程式讀到的帳本和上一期不是同一份。",
  EpochOutOfOrder: "期別不連續。先確認上一期承諾有沒有上鏈，再重跑 ledger:commit。",
  ZeroAmount: "數量要大於 0。",
  ERC20InsufficientBalance: "錢包裡的結算幣不夠。",
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

/// error 名稱與參數 → 一句話。參數裡包著另一個 error 的話拆開來講裡面那一個。
export function explainRevert(errorName: string, args: readonly unknown[]): string {
  for (const a of args) {
    if (typeof a === "string" && a.startsWith("0x") && a.length > 10) {
      const inner = describe(a as Hex);
      if (inner) return inner;
    }
  }
  const shown = args.length ? `${errorName}(${args.map(String).join(", ")})` : errorName;
  return HINT[errorName] ? `${shown} — ${HINT[errorName]}` : shown;
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
  ///     而真正的原因原封不動。
  ///
  /// 這一條是實際踩到才加的：一次簽章過期被說成「那個地址上的合約沒有這個函式」，
  /// 而地址其實完全正確。
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
