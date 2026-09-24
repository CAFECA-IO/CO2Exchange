import "server-only";
import { ERRORS, isErrorCode, type ErrorCode } from "@/lib/error-codes";
import { isStaleData } from "./fingerprint";
import { decodeRevert } from "./revert";
import { deployment } from "./chain";

/// 所有 API 回應的唯一出口。
///
/// 規則只有一條：**route 不直接呼叫 `Response.json`，一律走 `ok()` / `fail()`。**
/// `scripts/check-api-envelope.mjs` 會在 e2e 之前擋下違規，所以這條規則不靠人記得。
///
/// 為什麼值得統一：
///   · 以前每支 route 各自決定錯誤長什麼樣，前端只能比對字串來分支，
///     而字串是給人看的、隨時會改。改一次文案就壞一次邏輯。
///   · 鏈上資料裡到處是 bigint，`JSON.stringify` 碰到它會直接丟例外。
///     以前各處自己 `.toString()`，漏一個就是一支 500——而且只在有值的時候才發生。
///   · 成功與失敗的形狀不同，呼叫端才能用型別分辨，不必看 HTTP 狀態碼猜。

/// 對外的形狀。`ok` 這個布林值看起來多餘（HTTP 狀態碼已經說了），
/// 但它讓回應**自己描述自己**：log 裡、費思的工具結果裡、外部整合的程式碼裡，
/// 都不必再帶著當時的狀態碼才讀得懂。
export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = {
  ok: false;
  error: {
    code: ErrorCode;
    /// 給人看的一句話。**不要拿它做邏輯判斷**，那是 code 的工作。
    message: string;
    /// 可選的結構化補充：哪個欄位錯了、期待什麼、鏈上現在的值是多少。
    details?: unknown;
    /// 同樣的請求再送一次有沒有機會成功。前端據此決定要不要自動重試。
    retriable?: boolean;
  };
};
export type ApiResponse<T> = ApiOk<T> | ApiErr;

/// bigint 一律轉成字串。
///
/// 鏈上的數字超過 `Number.MAX_SAFE_INTEGER` 是常態（wei、1e18 的代幣），
/// 轉成 number 會**安靜地失真**——這比丟例外糟得多，因為它會一路傳到畫面上。
/// 所以用字串，讓呼叫端自己決定要怎麼解析。
const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function json(body: unknown, status: number, headers?: HeadersInit) {
  return new Response(JSON.stringify(body, replacer), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // API 回應預設不快取。這些端點多半帶著登入身分或鏈上當下的狀態，
      // 被中間層快取一次就會把某個人的持倉發給另一個人。
      // 要快取的端點自己覆寫這個標頭。
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function ok<T>(data: T, init?: { status?: number; headers?: HeadersInit }): Response {
  return json({ ok: true, data } satisfies ApiOk<T>, init?.status ?? 200, init?.headers);
}

export function fail(
  code: ErrorCode,
  opts?: { message?: string; details?: unknown; status?: number },
): Response {
  const spec = ERRORS[code];
  return json(
    {
      ok: false,
      error: {
        code,
        message: opts?.message ?? spec.message,
        ...(opts?.details === undefined ? {} : { details: opts.details }),
        ...("retriable" in spec && spec.retriable ? { retriable: true } : {}),
      },
    } satisfies ApiErr,
    opts?.status ?? spec.status,
  );
}

/// 在 route 裡任何地方 `throw new ApiError("INVALID_PARAM", …)`，
/// 由 `handleError` 統一轉成回應。比每一層都 return 好——
/// 深處的檢查不必把錯誤一路往上傳，也就不會在中途被改成別的形狀。
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? ERRORS[code].message);
    this.name = "ApiError";
  }
}

/// 這幾個判斷以前寫在 roles.ts 的 `handle()` 裡。搬過來是因為它們回答的是
/// 同一個問題：**這個例外對應到哪一個對外錯誤碼**。
function classify(e: unknown): { code: ErrorCode; message?: string; details?: unknown } {
  if (e instanceof ApiError) return { code: e.code, message: e.message, details: e.details };

  // 節點連不上（RPC 沒開、port 不對、鏈掛了）是環境問題，不是合約層錯誤。
  const chain = walk(e, /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed|HTTP request failed/i);
  if (chain) {
    const rpc = process.env.RPC_URL ?? "http://127.0.0.1:28545";
    return {
      code: "CHAIN_UNREACHABLE",
      message: `無法連線到區塊鏈節點（${rpc}）。請確認節點已啟動，且 web/.env.local 的 RPC_URL / CHAIN_ID 指向正確的鏈。`,
    };
  }

  // eth_call 回 "0x" 代表那個地址上根本沒有合約——幾乎都是部署檔與鏈對不上。
  if (walk(e, /returned no data \("0x"\)|Cannot decode zero data/i)) {
    const rpc = process.env.RPC_URL ?? "http://127.0.0.1:28545";
    return {
      code: "DEPLOYMENT_MISMATCH",
      message:
        `部署檔與鏈對不上：合約地址上沒有程式碼（${rpc}）。` +
        `通常是鏈重開後沒有重新部署。請重跑 forge script script/DeployV4.s.sol --rpc-url anvil --broadcast，` +
        `並確認 CHAIN_ID 與 deployments/<chainId>.json 對應到同一條鏈。`,
    };
  }

  if (isStaleData(e)) return { code: "DATA_STALE", message: e instanceof Error ? e.message : undefined };

  // 合約 revert。讀取也會 revert，不是只有送交易——以前只有 /api/relay 在拆，
  // 讀取那一側就一路掉到最後一行印「未分類的例外」，使用者拿到 INTERNAL。
  const rv = decodeRevert(e);
  if (rv) {
    // 空的 revert（沒有 error 資料）而且對象是部署檔裡的合約，幾乎一定是
    // **那個地址上的合約不是我們以為的那一個**：選擇器對不上 → fallback revert。
    //
    // 為什麼會發生：Anvil 重開後重新部署會沿用同一組地址（同部署者、同 nonce 順序），
    // 但換一支部署腳本（Deploy ↔ DeployV4）順序就變了，於是同一個地址上換成了
    // 另一個合約。地址「看起來對」，呼叫卻 revert，訊息裡完全看不出原因。
    // 只有**唯讀**呼叫空手 revert 才敢斷言部署檔對不上——理由見 revert.ts 的 isRead。
    const which = rv.empty && rv.isRead ? deployedAs(rv.contractAddress) : undefined;
    if (which) {
      return {
        code: "DEPLOYMENT_MISMATCH",
        message:
          `部署檔與鏈對不上：${which}（${rv.contractAddress}）上的合約沒有 ${rv.functionName ?? "這個函式"}，` +
          `呼叫直接被拒絕。多半是鏈重開後換了一支部署腳本——地址會重複使用，但合約換了一個。` +
          `請重跑 forge script script/DeployV4.s.sol --rpc-url anvil --broadcast，` +
          `並確認 CHAIN_ID 與 deployments/<chainId>.json 對應到同一條鏈。`,
        details: { contract: which, address: rv.contractAddress, functionName: rv.functionName },
      };
    }
    return {
      code: "CONTRACT_REVERTED",
      message: rv.message,
      details: { ...(rv.errorName ? { errorName: rv.errorName } : {}), address: rv.contractAddress, functionName: rv.functionName },
    };
  }

  // 認不出來的例外一律 500，並且**不要**把原始訊息丟給使用者：
  // 那裡面可能有檔案路徑、內部主機名稱或堆疊。留在伺服器 log 就好。
  console.error("[api] 未分類的例外", e);
  return { code: "INTERNAL" };
}

/// 這個地址是部署檔裡的哪一個合約？不是的話回 undefined。
/// 部署檔讀不到（還沒部署）也回 undefined——那是另一種錯，別在這裡混進來。
function deployedAs(address?: string): string | undefined {
  if (!address) return undefined;
  try {
    const d = deployment() as unknown as Record<string, unknown>;
    const target = address.toLowerCase();
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === "string" && v.toLowerCase() === target) return k;
    }
  } catch { /* 部署檔的問題由呼叫端自己處理 */ }
  return undefined;
}

function walk(e: unknown, re: RegExp): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 8; i++) {
    if (cur instanceof Error && re.test(cur.message)) return true;
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return false;
}

/// route 的 catch 一律呼叫這一支。
export function handleError(e: unknown): Response {
  const { code, message, details } = classify(e);
  return fail(code, { message, details });
}

/// 把不認得的字串轉成錯誤碼，認不得就退回 INTERNAL。
/// 給少數需要從外部資料還原錯誤碼的地方用（例如重送佇列）。
export const toErrorCode = (v: unknown): ErrorCode => (isErrorCode(v) ? v : "INTERNAL");
