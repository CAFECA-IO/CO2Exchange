/// 本站 API 的錯誤碼。**這份清單是對外契約的一部分。**
///
/// 刻意**不標 `server-only`**：前端要能 `if (e.code === "WALLET_NOT_DEPLOYED")` 分支，
/// 就得看得到同一份定義。契約放在兩邊都 import 得到的地方，才不會各維護一份而漂移。
///
/// 為什麼要有它：原本每一支 route 各自決定錯誤長什麼樣，於是前端看到的是
/// `"account"`、`"unauthenticated"`、`"bad request"`、`"no-code"`——
/// 有中文有英文、有的是欄位名、有的是狀態名，而且只有三處帶 `code`。
/// 前端想針對某個錯誤做事（例如「錢包還沒部署就自動重建」）只能去比對字串，
/// 而字串是給人看的、隨時會被改掉。改一次文案就壞一次邏輯。
///
/// 粒度取中間：**按原因分類，不是按發生地點**。太粗（只有 AUTH / INPUT）前端無從分支；
/// 太細（每個合約 error 一個碼）則合約一改版就要同步，而那件事 lib/error-abi.ts 已經在做了。
///
/// 每個碼帶三樣東西：預設 HTTP 狀態、預設訊息、以及「值不值得重試」。
/// 最後一項讓前端不必自己維護一張重試表——那張表遲早會跟這裡不一致。

export type ErrorSpec = {
  status: number;
  /// 沒有另外給訊息時用這一句。給人看的，所以是中文。
  message: string;
  /// 同樣的請求再送一次有沒有機會成功。暫時性的環境問題才是 true。
  retriable?: boolean;
};

export const ERRORS = {
  // ── 身分與權限 ────────────────────────────────────────────────
  UNAUTHENTICATED: { status: 401, message: "請先登入" },
  FORBIDDEN: { status: 403, message: "沒有權限執行這個操作" },
  ADMIN_REQUIRED: { status: 403, message: "需要管理員權限" },
  VERIFIER_REQUIRED: { status: 403, message: "需要查驗機構權限" },
  /// 登入了，但鏈上身分不足（未驗證、過期、被凍結）
  KYC_REQUIRED: { status: 403, message: "這個操作需要有效的鏈上身分驗證" },

  // ── 輸入 ─────────────────────────────────────────────────────
  INVALID_PARAM: { status: 400, message: "參數不正確" },
  MISSING_PARAM: { status: 400, message: "缺少必要參數" },
  INVALID_ADDRESS: { status: 400, message: "地址格式不正確" },
  INVALID_COUNTRY: { status: 400, message: "國別要是兩碼英文代碼，例如 TW" },
  INVALID_PUBLIC_KEY: { status: 400, message: "公鑰必須是 64 bytes 的 x||y" },
  UNSUPPORTED_ACTION: { status: 400, message: "不支援的操作" },
  FILE_TOO_LARGE: { status: 413, message: "檔案太大" },
  UNSUPPORTED_FILE_TYPE: { status: 415, message: "不支援的檔案格式" },

  // ── 找不到 ───────────────────────────────────────────────────
  NOT_FOUND: { status: 404, message: "找不到這個資源" },
  AGREEMENT_NOT_FOUND: { status: 404, message: "找不到這份契約" },
  CREDENTIAL_NOT_FOUND: { status: 404, message: "這把 passkey 沒有對應的錢包紀錄" },
  CERTIFICATE_NOT_FOUND: { status: 404, message: "找不到這張憑證" },
  DOCUMENT_NOT_READY: { status: 404, message: "文件尚未產生" },
  PROJECT_NOT_FOUND: { status: 404, message: "找不到這個專案" },

  // ── 狀態衝突（請求沒錯，但現在做不了）─────────────────────────
  /// 錢包在目前這條鏈上還沒有合約。**這不是錯誤，是可預期的狀態**——
  /// 呼叫端據此重建再問一次。用專屬的碼而不是 404，是為了讓前端不必比對字串。
  WALLET_NOT_DEPLOYED: { status: 409, message: "這個錢包在目前這條鏈上還不存在" },
  WALLET_FROZEN: { status: 409, message: "這個錢包已被凍結" },
  KEY_NOT_ON_CHAIN: { status: 409, message: "這把金鑰還沒上鏈" },
  ORDER_INACTIVE: { status: 409, message: "這張單已經被買走或取消了" },
  INSUFFICIENT_BALANCE: { status: 409, message: "餘額不足" },
  ALREADY_EXISTS: { status: 409, message: "已經存在，不需要再建立一次" },

  // ── 鏈與環境 ─────────────────────────────────────────────────
  CHAIN_UNREACHABLE: { status: 503, message: "無法連線到區塊鏈節點", retriable: true },
  DEPLOYMENT_MISMATCH: { status: 503, message: "部署檔與鏈對不上" },
  DATA_STALE: { status: 503, message: "本機資料屬於另一次部署" },
  /// 合約 revert。訊息由 lib/error-abi.ts 拆解到看得懂為止。
  CONTRACT_REVERTED: { status: 400, message: "鏈上交易被拒絕" },

  // ── 上游與流量 ───────────────────────────────────────────────
  RATE_LIMITED: { status: 429, message: "請求太頻繁，休息一下再試", retriable: true },
  UPSTREAM_ERROR: { status: 502, message: "上游服務回應異常", retriable: true },
  UPSTREAM_TIMEOUT: { status: 504, message: "上游服務逾時", retriable: true },

  // ── 其他 ────────────────────────────────────────────────────
  INTERNAL: { status: 500, message: "伺服器內部錯誤", retriable: true },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERRORS;

export const isErrorCode = (v: unknown): v is ErrorCode =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(ERRORS, v);
