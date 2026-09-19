import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";

/// Phase 0：credentialId → 帳戶 的對照放本機 JSON。
/// 正式環境放營運資料庫，或改讀鏈上 AccountCreated 事件索引。
type Row = { publicKey: Hex; address: Address; createdAt: string };
const FILE = process.env.ACCOUNTS_FILE ?? path.resolve(process.cwd(), "data", "accounts.json");

function load(): Record<string, Row> {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; }
}

export function getAccount(credentialId: string): Row | undefined {
  return load()[credentialId];
}

export function putAccount(credentialId: string, row: Omit<Row, "createdAt">) {
  const all = load();
  all[credentialId] = { ...row, createdAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}
