import crypto from "node:crypto";

/// 個人資料欄位的靜態加密（AES-256-GCM）。
///
/// 網站、營運工具與資料遷移腳本共用這一支，所以它不依賴 Next，也不自己讀環境變數——
/// 金鑰由呼叫端給（網站：lib/server/sealed.ts；腳本：scripts/data-protect.mjs）。
///
/// 格式：`sealed:v1:<kid>:<iv>:<密文>:<tag>`（base64url）。
///   · kid 是金鑰 SHA-256 的前 8 個 hex：換金鑰之後還認得舊資料是哪一把加的，解不開時錯誤說得清楚。
///   · AAD 綁住「這是哪個帳戶的哪個欄位」：把甲的密文貼到乙的紀錄上，GCM 驗證會失敗，而不是悄悄解出甲的資料。
///
/// 不做的事：不加密整個檔案（紀錄的其他欄位——地址、狀態、時間——要能直接查）；
/// 不做確定性加密（同一個帳號兩次加密結果不同，密文不能拿來比對是誰）。要比對用 payoutRef／identityHash 那種加鹽雜湊。

export const SEALED_PREFIX = "sealed:v1:";

/// 本機鏈（anvil）沒設 DATA_KEY 時用的展示金鑰。和 anvil 的預設帳戶一樣是公開的，只能在本機用；
/// 網站（lib/server/sealed.ts）與遷移腳本（scripts/data-protect.mjs）必須用同一把，所以放在這裡。
export const DEV_DATA_KEY_TEXT = crypto.createHash("sha256").update("co2x-dev-data-key: 只限本機鏈，公開的").digest("hex");

export type DataKey = { kid: string; key: Buffer };

/// 金鑰文字 → 32 bytes。接受 base64（`openssl rand -base64 32`）或 64 個 hex（可帶 0x）。
/// 錯誤訊息只描述形狀，不回顯內容。
export function parseDataKey(text: string): DataKey {
  const t = text.trim();
  let key: Buffer | null = null;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) key = Buffer.from(t.replace(/^0x/, ""), "hex");
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) {
    const b = Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 32) key = b;
  }
  if (!key) throw new Error(`資料加密金鑰格式不對（長度 ${t.length}）：要是 32 bytes 的 base64（openssl rand -base64 32）或 64 個 hex`);
  return { kid: crypto.createHash("sha256").update(key).digest("hex").slice(0, 8), key };
}

export const isSealed = (v: unknown): v is string => typeof v === "string" && v.startsWith(SEALED_PREFIX);

const b64u = (b: Buffer) => b.toString("base64url");

export function seal(plain: string, k: DataKey, aad: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k.key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${SEALED_PREFIX}${k.kid}:${b64u(iv)}:${b64u(ct)}:${b64u(c.getAuthTag())}`;
}

export class SealedError extends Error {
  readonly reason: "no-key" | "bad-format" | "auth-failed";
  constructor(message: string, reason: "no-key" | "bad-format" | "auth-failed") { super(message); this.reason = reason; }
}

/// 用任一把認得的金鑰解開。解不開就丟 SealedError——**不回傳密文或空字串當作明文**。
export function open(sealed: string, keys: DataKey[], aad: string): string {
  if (!isSealed(sealed)) throw new SealedError("不是加密欄位", "bad-format");
  const parts = sealed.slice(SEALED_PREFIX.length).split(":");
  if (parts.length !== 4) throw new SealedError("加密欄位格式不對", "bad-format");
  const [kid, iv, ct, tag] = parts;
  const k = keys.find((x) => x.kid === kid);
  if (!k) throw new SealedError(`這筆資料是金鑰 ${kid} 加密的，目前設定的金鑰（${keys.map((x) => x.kid).join("、") || "沒有"}）解不開`, "no-key");
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", k.key, Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    throw new SealedError("加密欄位驗證失敗（資料被改過，或放錯了紀錄）", "auth-failed");
  }
}

/// AAD：集合、欄位、帳戶。帳戶用小寫，同一個人不論地址大小寫都解得開。
export const aadOf = (collection: string, field: string, account: string) => `co2x:${collection}:${field}:${account.toLowerCase()}`;

/// 遮罩。帳號保留末四碼；身分證號／統編保留字首與末兩碼（審核者核對得了是哪一筆，其餘看不到）。
export const maskTail = (s: string, keep = 4) => (s.length <= keep ? "•".repeat(s.length) : `${"•".repeat(s.length - keep)}${s.slice(-keep)}`);
export const maskIdNumber = (s: string) => (s.length < 6 ? "•".repeat(s.length) : `${s.slice(0, 1)}${"•".repeat(s.length - 3)}${s.slice(-2)}`);
