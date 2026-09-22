import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import { deploymentFingerprint } from "./fingerprint";

/// Phase 0：passkey → 錢包 的對照放本機 JSON。正式環境放營運資料庫，
/// 或直接索引鏈上的 `KeyAdded` 事件（鏈上本來就有 keyId、label、時間）。
///
/// **鏈才是權威**：一把 passkey 現在能不能動這個錢包，只有合約的 `keys()` 說了算。
/// 這份檔案存的是鏈上沒有、而瀏覽器需要的那一塊：keyId ↔ credentialId。
/// 沒有它，介面知道「這個錢包有三把金鑰」，卻不知道要叫瀏覽器用哪一個
/// credentialId 去喚起哪一把——WebAuthn 簽章需要 credentialId，而它不上鏈。
export type KeyRow = {
  credentialId: string;
  /// 64-byte 未壓縮公鑰（x||y，不含 0x04 前綴）
  publicKey: Hex;
  /// keccak256(abi.encode(qx, qy))：合約裡認金鑰用的 id
  keyId: Hex;
  accountRef: Hex;
  address: Address;
  /// 使用者看得懂的裝置名稱。鏈上也有一份，這裡留著是為了離線時也顯示得出來。
  label: string;
  createdAt: string;
  userId?: string;
  email?: string;
  /// 這把金鑰**還沒上鏈**：使用者在一台新裝置上登入、建了一把 passkey，
  /// 但加金鑰必須由**現有裝置**簽字（新裝置沒有任何權限，否則登入被盜就等於錢包被盜）。
  /// 所以它先停在這裡，等某一台現有裝置核准。
  pending?: boolean;
};

/// 待核准的新裝置放多久。過期就當作沒發生過——一個長期掛在畫面上的
/// 「有新裝置要求加入」是在訓練使用者忽略它，而那正是攻擊者需要的。
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

type Doc = { fingerprint: string; chainId: number; keys: Record<string, KeyRow> };
const FILE = process.env.ACCOUNTS_FILE ?? path.resolve(process.cwd(), "data", "accounts.json");

/// 這份對照跟其他紀錄不一樣：地址是 CREATE2 從 factory + accountRef 算出來的，
/// 也就是**可以重算**。所以 factory 換了地方時不需要攔下整個系統——舊的對照當作
/// 不存在，重新綁一次就會拿到新鏈上的地址。硬擋反而會讓自動重綁失效。
function load(): Doc {
  const fp = deploymentFingerprint();
  const empty = { fingerprint: fp.fingerprint, chainId: fp.chainId, keys: {} };
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return empty; }
  const doc = raw as Partial<Doc> & { rows?: unknown };
  // v1 的格式是 { rows: { credentialId: { publicKey, address } } }：那時候地址由公鑰決定，
  // 換一把 passkey 就是換一個錢包。新模型下那些地址算不出來也對不上，直接丟掉——
  // 這是 Phase 0 展示站，重綁一次的成本遠低於留著一份會產生錯誤答案的舊資料。
  if (doc.rows && !doc.keys) return empty;
  if (typeof doc.fingerprint === "string" && doc.fingerprint !== fp.fingerprint) {
    console.warn(`[accounts] accounts.json 屬於部署 ${doc.fingerprint}，目前是 ${fp.fingerprint}；舊對照忽略，passkey 會重新綁定。`);
    return empty;
  }
  return { fingerprint: fp.fingerprint, chainId: fp.chainId, keys: doc.keys ?? {} };
}

function save(doc: Doc) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(doc, null, 2));
}

export function keyByCredential(credentialId: string): KeyRow | undefined {
  return load().keys[credentialId];
}

export function keyById(keyId: Hex): KeyRow | undefined {
  return Object.values(load().keys).find((k) => k.keyId.toLowerCase() === keyId.toLowerCase());
}

/// 這個錢包登記過的所有 passkey（含已經被撤掉的——撤掉與否問鏈）。
export function keysOfRef(accountRef: Hex): KeyRow[] {
  return Object.values(load().keys)
    .filter((k) => k.accountRef.toLowerCase() === accountRef.toLowerCase())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function putKey(row: Omit<KeyRow, "createdAt"> & { createdAt?: string }) {
  const doc = load();
  const prev = doc.keys[row.credentialId];
  doc.keys[row.credentialId] = { ...row, createdAt: row.createdAt ?? prev?.createdAt ?? new Date().toISOString() };
  save(doc);
}

/// 撤掉一把金鑰之後把對照也刪掉。鏈上仍留著 `KeyRemoved` 事件當紀錄，
/// 這裡不需要再保留 credentialId——它已經沒有用途，而留著只是多一筆
/// 「哪一台裝置屬於誰」的個資。
/// 這個錢包待核准的新裝置（已過期的自動略過）。
export function pendingOfRef(accountRef: Hex): KeyRow[] {
  const now = Date.now();
  return keysOfRef(accountRef).filter(
    (k) => k.pending && now - Date.parse(k.createdAt) < PENDING_TTL_MS,
  );
}

export function dropKey(keyId: Hex) {
  const doc = load();
  for (const [cid, k] of Object.entries(doc.keys)) {
    if (k.keyId.toLowerCase() === keyId.toLowerCase()) delete doc.keys[cid];
  }
  save(doc);
}
