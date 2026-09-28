// 腳本（ledger:commit、ledger:seed、mm、ledger:authority…）的金鑰來源。
//
// 為什麼需要這支：bootstrap.sh 把服務金鑰寫進 web/.env.local，但 node 腳本
// 原本只看 shell 的環境變數。結果是兩種失敗——
//   1. shell 裡什麼都沒有 → 默默退回 anvil 的公開金鑰（公開鏈上沒錢、沒角色）；
//   2. shell 裡有一個從 README 抄來的 `DEPLOYER_PK=0x…` → viem 報
//      「invalid private key … got string」，看不出是哪一個變數、錯在哪裡。
//
// 規則：
//   · shell 的值優先（跟 Next 讀 .env.local 的規則一樣），檔案只補 shell 沒有的；
//   · 檔案裡的 CHAIN_ID 若跟目前連上的鏈不同，檔案裡的**金鑰**一律不採用——
//     開發機上的 .env.local 常常是 Boltchain 的設定，而人在跑 anvil；
//   · 任何金鑰都先驗格式（0x + 64 hex）再用；錯誤訊息只說變數名稱與長度，**不印值**；
//   · 公開鏈上拒絕 anvil 的預設金鑰。
import fs from "node:fs";
import path from "node:path";

export const ANVIL_PK0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

export const ENV_FILE = process.env.ENV_FILE ?? path.resolve(process.cwd(), ".env.local");

/// 解析 KEY=VALUE。不做變數展開、不處理多行——bootstrap.sh 寫出來的就是這種格式。
export function parseEnvFile(file = ENV_FILE) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const fileEnv = parseEnvFile();

/// 非金鑰的設定（RPC_URL 之類）：shell 優先，檔案補。
export function setting(name) {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  const f = fileEnv[name];
  return f !== undefined && f !== "" ? f : undefined;
}

const HEX64 = /^0x[0-9a-fA-F]{64}$/;

function describe(v) {
  // 只描述形狀，絕不回顯內容
  if (v.includes("…") || v === "0x" || /^0x\.+$/.test(v)) return "看起來是 README 的佔位字「0x…」，不是真的金鑰";
  if (!v.startsWith("0x")) return `沒有 0x 開頭（長度 ${v.length}）`;
  return `長度 ${v.length}，應為 66（0x + 64 個十六進位字元）`;
}

/// 建立金鑰讀取器。`chainId` 是**已經連上**的鏈；`isLocal` 決定能不能退回 anvil 金鑰。
export function keyring({ chainId, isLocal }) {
  const fileChain = fileEnv.CHAIN_ID ? Number(fileEnv.CHAIN_ID) : undefined;
  const fileUsable = fileChain === undefined || fileChain === chainId;
  const notes = [];
  if (!fileUsable && Object.keys(fileEnv).some((k) => k.endsWith("_PK"))) {
    notes.push(`web/.env.local 是 chainId ${fileChain} 的設定，現在連的是 ${chainId}——不採用檔案裡的金鑰。`);
  }

  /// 依序找第一個有值的變數，回傳 { name, pk, source }；都沒有就 undefined。
  function find(...names) {
    for (const n of names) {
      const sv = process.env[n];
      if (sv !== undefined && sv !== "") return { name: n, pk: check(n, sv, "shell 環境變數"), source: "shell" };
      const fv = fileUsable ? fileEnv[n] : undefined;
      if (fv !== undefined && fv !== "") return { name: n, pk: check(n, fv, "web/.env.local"), source: "web/.env.local" };
    }
    return undefined;
  }

  function check(name, v, where) {
    if (!HEX64.test(v)) {
      const hint = where === "shell 環境變數"
        ? `\n  這個值來自目前 shell 的環境變數（會蓋過 web/.env.local）。若是之前照文件 export 的，請先：\n\n    unset ${name}\n`
        : `\n  請檢查 web/.env.local 的 ${name}=，或重跑 bash script/bootstrap.sh keys（不會覆蓋可用的金鑰）。\n`;
      throw new KeyError(`${name}（來自 ${where}）不是有效的私鑰：${describe(v)}。${hint}`);
    }
    if (!isLocal && v.toLowerCase() === ANVIL_PK0) {
      throw new KeyError(`${name} 是 anvil 的公開預設金鑰，chainId ${chainId} 不是本機鏈。請換成這條鏈專用的金鑰（bash script/bootstrap.sh keys）。`);
    }
    return v;
  }

  /// 必須存在的金鑰。本機鏈上缺了就用 anvil account0（與過去行為一致）。
  function require(...names) {
    const hit = find(...names);
    if (hit) return hit;
    if (isLocal) return { name: "ANVIL_PK0", pk: ANVIL_PK0, source: "anvil 預設" };
    throw new KeyError(
      `chainId ${chainId} 不是本機鏈，需要 ${names.join(" 或 ")}。\n` +
      `  bootstrap.sh 會把它寫在 web/.env.local；確認該檔的 CHAIN_ID=${chainId}，或先跑 bash script/bootstrap.sh keys。`,
    );
  }

  /// 可選的金鑰：沒有就回傳 fallback（通常是營運金鑰）。
  function optional(fallback, ...names) {
    return find(...names) ?? fallback;
  }

  /// 非金鑰的秘密（助記詞）：同樣受「檔案是不是這條鏈的」約束。
  function secret(name) {
    const sv = process.env[name];
    if (sv !== undefined && sv !== "") return { value: sv, source: "shell" };
    const fv = fileUsable ? fileEnv[name] : undefined;
    return fv ? { value: fv, source: "web/.env.local" } : undefined;
  }

  return { require, optional, secret, notes, fileUsable };
}

export class KeyError extends Error {}

/// 把一行 KEY=VALUE 寫進 .env.local（已存在就不動）。只用在模擬器自己產生的助記詞。
export function appendIfMissing(name, value, file = ENV_FILE) {
  const cur = parseEnvFile(file);
  if (cur[name]) return false;
  const prefix = fs.existsSync(file) && !fs.readFileSync(file, "utf8").endsWith("\n") ? "\n" : "";
  fs.appendFileSync(file, `${prefix}${name}=${value}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* 權限調不動就算了，檔案本來就在 .gitignore */ }
  fileEnv[name] = value;
  return true;
}
