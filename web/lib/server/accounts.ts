import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import { deploymentFingerprint } from "./fingerprint";

/// Phase 0：credentialId → 帳戶 的對照放本機 JSON。
/// 正式環境放營運資料庫，或改讀鏈上 AccountCreated 事件索引。
type Row = { publicKey: Hex; address: Address; createdAt: string };
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
