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
/// 用來回答「我明明有帳戶，為什麼叫我重新建立」：使用者換裝置或清掉瀏覽器資料之後，
/// 這台裝置沒有 credential，但伺服器知道這個人綁過什麼。知道了才講得出實話——
/// 「帳戶在，這台裝置還沒綁定，用同一把 passkey 綁回來就好」。
///
/// 只回地址與時間。credentialId 與公鑰是拿來簽章與查詢的鍵，沒有必要送回瀏覽器。
export function accountsOf(userId: string): { address: Address; createdAt: string }[] {
  const seen = new Set<string>();
  return Object.values(load().rows)
    .filter((r) => r.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((r) => (seen.has(r.address.toLowerCase()) ? false : seen.add(r.address.toLowerCase())))
    .map((r) => ({ address: r.address, createdAt: r.createdAt }));
}
