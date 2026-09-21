import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import { deploymentFingerprint } from "./fingerprint";

/// Phase 0：credentialId → 帳戶 的對照放本機 JSON。
/// 正式環境放營運資料庫，或改讀鏈上 AccountCreated 事件索引。
/// userId / email 是**後來才加的**，舊資料沒有。加它們的理由：沒有這兩個欄位，
/// 伺服器只能用 credentialId 查帳戶，而 credentialId 在使用者換一台裝置、
/// 或清掉瀏覽器資料之後就沒了——於是畫面只能說「尚未建立鏈上帳戶」，
/// 而那句話是錯的：帳戶好端端在鏈上，只是這台裝置不知道。
type Row = { publicKey: Hex; address: Address; createdAt: string; userId?: string; email?: string };
type Doc = { fingerprint: string; chainId: number; rows: Record<string, Row> };
const FILE = process.env.ACCOUNTS_FILE ?? path.resolve(process.cwd(), "data", "accounts.json");

/// 這份對照跟其他紀錄不一樣：地址是 CREATE2 從 factory + passkey 公鑰算出來的，
/// 也就是**可以重算**。所以 factory 換了地方時不需要攔下整個系統 —— 舊的對照當作
/// 不存在，前端重新註冊一次就會拿到新鏈上的地址。硬擋反而會讓自動重綁失效。
function load(): Doc {
  const fp = deploymentFingerprint();
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { fingerprint: fp.fingerprint, chainId: fp.chainId, rows: {} }; }
  const doc = raw as Partial<Doc> & Record<string, unknown>;
  // 舊格式是扁平的 { credentialId: Row }，沒有指紋。沿用它，並在下一次寫入時補上戳記。
  const rows = (doc.rows ?? (doc as Record<string, Row>)) as Record<string, Row>;
  const stamped = typeof doc.fingerprint === "string" ? doc.fingerprint : undefined;
  if (stamped && stamped !== fp.fingerprint) {
    console.warn(`[accounts] accounts.json 屬於部署 ${stamped}，目前是 ${fp.fingerprint}；舊對照忽略，passkey 會重新綁定新地址。`);
    return { fingerprint: fp.fingerprint, chainId: fp.chainId, rows: {} };
  }
  return { fingerprint: fp.fingerprint, chainId: fp.chainId, rows: rows ?? {} };
}

export function getAccount(credentialId: string): Row | undefined {
  return load().rows[credentialId];
}

export function putAccount(credentialId: string, row: Omit<Row, "createdAt">) {
  const doc = load();
  doc.rows[credentialId] = { ...row, createdAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(doc, null, 2));
}

/// 這個登入帳號綁過哪些鏈上帳戶（去重、最新的在前）。
///
/// 這是「登入」之所以有意義的地方：登入告訴我們你是誰，我們就該把你的帳戶還給你，
/// 而不是每次都問「要不要建立帳戶」。沒有這個查詢，帳戶等於只存在於某一個瀏覽器的
/// localStorage 裡——清掉、換裝置、換個登入方式，就像沒有過。
///
/// **同時比對 userId 與 email**：userId 是登入供應商給的（Google 一組、開發用登入
/// 另一組），同一個人用不同方式登入會拿到不同的 userId。而這個系統其他地方
/// （ADMIN_EMAILS、VERIFIER_EMAILS、KYC 紀錄）本來就以 email 認人，這裡跟著一致。
///
/// 回傳含 credentialId 與公鑰，讓前端能**無聲地**把綁定還原回來。這兩個都是公開值：
/// 公鑰本來就是公開的，credentialId 只是一個識別碼；拿到它們也簽不了任何東西，
/// 簽章需要 authenticator 裡的私鑰。而呼叫者已經是通過驗證的本人。
export function accountsOf(userId: string, email?: string | null) {
  const mail = email?.toLowerCase();
  const seen = new Set<string>();
  return Object.entries(load().rows)
    .filter(([, r]) => r.userId === userId || (!!mail && r.email?.toLowerCase() === mail))
    .sort(([, a], [, b]) => b.createdAt.localeCompare(a.createdAt))
    .filter(([, r]) => (seen.has(r.address.toLowerCase()) ? false : seen.add(r.address.toLowerCase())))
    .map(([credentialId, r]) => ({ address: r.address, createdAt: r.createdAt, credentialId, publicKey: r.publicKey }));
}
