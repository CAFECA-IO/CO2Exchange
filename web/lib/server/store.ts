import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR as DIR, assertDataFresh } from "./fingerprint";

/// Phase 0 資料層：每個集合一個 JSON 檔（web/data/<name>.json）。正式環境換營運資料庫，介面不變。
/// 每次進出都先確認資料夾與目前部署是同一批（見 fingerprint.ts）：
/// 這些紀錄用帳戶地址當鍵，換了部署就全部對不上。

export type WithId = { id: string; createdAt: string; updatedAt: string };

function file(name: string) { return path.join(DIR, `${name}.json`); }
function load<T extends WithId>(name: string): T[] {
  assertDataFresh();
  try { return JSON.parse(fs.readFileSync(file(name), "utf8")); } catch { return []; }
}
function save<T extends WithId>(name: string, rows: T[]) {
  assertDataFresh();
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify(rows, null, 2));
}

export function all<T extends WithId>(name: string): T[] { return load<T>(name); }
export function find<T extends WithId>(name: string, id: string): T | undefined { return load<T>(name).find((r) => r.id === id); }
export function insert<T extends WithId>(name: string, row: Omit<T, keyof WithId>): T {
  const rows = load<T>(name);
  const now = new Date().toISOString();
  const full = { ...row, id: crypto.randomUUID().slice(0, 8), createdAt: now, updatedAt: now } as T;
  rows.push(full); save(name, rows); return full;
}
export function patch<T extends WithId>(name: string, id: string, changes: Partial<T>): T {
  const rows = load<T>(name);
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) throw new Error(`${name}/${id} not found`);
  rows[i] = { ...rows[i], ...changes, updatedAt: new Date().toISOString() };
  save(name, rows); return rows[i];
}

export const UPLOAD_DIR = path.join(DIR, "uploads");
export function saveUpload(buf: Buffer, ext: string) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const name = `${sha}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { sha256: `0x${sha}` as `0x${string}`, name };
}
export function readUpload(name: string) {
  if (!/^[0-9a-f]{64}(\.[a-z0-9]{1,5})?$/.test(name)) throw new Error("bad upload name");
  return fs.readFileSync(path.join(UPLOAD_DIR, name));
}
