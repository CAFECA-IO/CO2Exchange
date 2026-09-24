"use client";
import type { ErrorCode } from "@/lib/error-codes";

/// 前端呼叫本站 API 的唯一入口。
///
/// 它做三件事，每一件都對應到一個真的發生過的問題：
///
/// 1. **拆信封。** 所有 API 回的都是 `{ok:true,data}` 或 `{ok:false,error}`
///    （見 lib/server/api.ts）。呼叫端拿到的是 `data`，不必每次都寫一次拆解。
/// 2. **失敗就丟，而且帶著錯誤碼。** 以前各處都是
///    `fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => {})`——
///    失敗變成 null，呼叫端的 `if (x)` 擋掉，於是畫面永遠停在載入中，
///    沒有訊息也沒有重試。那個 bug 讓「錢包尚未建立」的人卡在門檻畫面上。
/// 3. **會重試。** 退避 0.4s → 1.2s。要不要重試由**伺服器**說了算
///    （`error.retriable`），前端不自己維護一張會漂移的重試表。

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /// 伺服器給的錯誤碼。用它做邏輯判斷，**不要比對 message**——
    /// message 是給人看的，隨時會被改寫。
    readonly code?: ErrorCode,
    readonly details?: unknown,
    readonly retriable = false,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

/// 舊名稱，沿用以免一次改動太多呼叫端。
export { ApiClientError as FetchError };

/// 連不上、逾時、被限流與 5xx 值得再試；401/403/404 不值得——
/// 那是「你不能」或「沒有這個東西」，再問一百次答案一樣。
const retriableStatus = (s: number) => s === 0 || s === 408 || s === 429 || s >= 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string; details?: unknown; retriable?: boolean } };

export async function fetchJson<T>(
  url: string,
  opts: RequestInit & { retries?: number } = {},
): Promise<T> {
  const { retries = 2, ...init } = opts;
  let last: ApiClientError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(400 * 3 ** (attempt - 1));
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    }
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      let body: Envelope<T> | null = null;
      let parsed = false;
      try { body = text ? (JSON.parse(text) as Envelope<T>) : null; parsed = true; } catch { /* 下面處理 */ }

      if (!parsed || body === null) {
        // 200 但讀不懂也算失敗。曾經在這裡直接回傳 null，呼叫端把它設進 state，
        // 畫面讀欄位時整個白掉——比原本的錯誤更難查。
        last = new ApiClientError("伺服器回了一個讀不懂的回應", res.status || 0, undefined, undefined, true);
      } else if (body.ok) {
        return body.data;
      } else {
        const e = body.error;
        last = new ApiClientError(e.message, res.status, e.code, e.details, !!e.retriable);
        // 伺服器說不值得重試就不重試，即使狀態碼看起來像暫時性的。
        if (!e.retriable && !retriableStatus(res.status)) break;
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      last = new ApiClientError(e instanceof Error ? e.message : String(e), 0, undefined, undefined, true);
    }
  }
  throw last ?? new ApiClientError("未知的錯誤", 0);
}

/// 送 JSON 出去。**預設不重試**，和 fetchJson 相反。
///
/// 因為寫入不是冪等的：/api/relay 會送出一筆真的交易、/api/faucet 會撥款、
/// /api/kyc 會簽發身分。那些請求在「連線斷掉」或「回了 502」的時候，
/// 伺服器端很可能已經做完了——重試一次就是做第二次。讀取重試最多是多問一次，
/// 寫入重試是多做一件事，兩者不該共用同一個預設值。
///
/// 真的冪等的寫入（例如「把這批同意記下來」）可以自己傳 `retries`。
export const postJson = <T>(url: string, body: unknown, opts: RequestInit & { retries?: number } = {}) =>
  fetchJson<T>(url, {
    retries: 0,
    ...opts,
    method: opts.method ?? "POST",
    headers: { "content-type": "application/json", ...opts.headers },
    body: JSON.stringify(body),
  });

export type Loadable<T> =
  | { state: "loading" }
  | { state: "error"; error: ApiClientError }
  | { state: "ready"; value: T };
