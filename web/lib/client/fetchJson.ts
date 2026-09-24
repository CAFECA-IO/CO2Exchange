"use client";

/// 會重試、而且**失敗時說得出原因**的 fetch。
///
/// 為什麼需要它：原本各處都是
/// `fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => {})`。
/// 那一行有三個問題疊在一起：
///   1. `r.ok` 是 false 就得到 null，呼叫端多半寫 `if (x) setState(x)`——於是失敗＝什麼都沒發生。
///   2. `catch` 是空的，錯誤被吞掉，主控台也看不到。
///   3. 沒有重試。
/// 結果是：任何一次暫時性的失敗（RPC 抖一下、serverless 冷啟動逾時、
/// session cookie 與第一個請求的競態）都會讓畫面**永久**停在載入中，
/// 沒有訊息、沒有重試、沒有出口。使用者只能重新整理——如果他猜得到要這麼做。
///
/// 這支把三件事一起修掉：分得出「還在載入」與「失敗了」、會自己退避重試、
/// 而且把伺服器已經寫好的那些人話訊息（CHAIN_UNREACHABLE、DATA_STALE…）帶回來。

export class FetchError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "FetchError";
  }
}

/// 值得再試一次的失敗：連不上、逾時、被限流，以及 5xx。
/// 401/403/404 重試沒有意義——那是「你不能」或「沒有這個東西」，再問一百次答案一樣。
const retriable = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson<T>(
  url: string,
  opts: RequestInit & { retries?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const { retries = 2, ...init } = opts;
  let last: FetchError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 0.4s → 1.2s。退避是為了給對面喘息，不是為了拖時間，所以上限壓得很低：
      // 使用者正盯著一個載入中的畫面。
      await sleep(400 * 3 ** (attempt - 1));
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    }
    try {
      const res = await fetch(url, init);
      // 先拿文字再自己 parse：`res.json()` 失敗時分不出「伺服器回了壞東西」與
      // 「網路斷在一半」，而這兩種都不該被當成「成功，值是 null」。
      const text = await res.text();
      let body: (Record<string, unknown> & { error?: string; code?: string }) | null = null;
      let parsed = false;
      try { body = text ? JSON.parse(text) : null; parsed = true; } catch { /* 下面處理 */ }

      if (res.ok) {
        // **200 但解不出 JSON，或解出來是 null，不算成功。**
        // 這裡曾經直接 `return body as T`，於是呼叫端拿到 null 並把它設進 state，
        // 畫面在讀那個物件的欄位時整個炸掉——比原本的錯誤更難查。
        if (parsed && body !== null) return body as T;
        last = new FetchError("伺服器回了一個讀不懂的回應", 0);
      } else {
        last = new FetchError(
          (typeof body?.error === "string" && body.error) || `伺服器回應 ${res.status}`,
          res.status,
          body?.code,
        );
        if (!retriable(res.status)) break;
      }
    } catch (e) {
      // 連 fetch 本身都失敗（離線、DNS、CORS、被中止）
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      last = new FetchError(e instanceof Error ? e.message : String(e), 0);
    }
  }
  throw last ?? new FetchError("未知的錯誤", 0);
}

/// 三態。`null` 一個值兼差「還沒問到」與「問不到」是上面那個 bug 的根源，
/// 所以型別層就把它們分開，讓畫面不可能把兩者畫成同一件事。
export type Loadable<T> =
  | { state: "loading" }
  | { state: "error"; error: FetchError }
  | { state: "ready"; value: T };
