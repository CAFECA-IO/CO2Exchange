import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CHAIN_ID, deployment } from "./chain";

/// 部署指紋：web/data/ 裡的紀錄是用「帳戶地址」當鍵的，而地址是合約部署的產物。
/// 鏈重開、換鏈、或 factory 重新部署之後，那些鍵指向的帳戶在新鏈上並不存在，
/// 但資料讀得出來、畫面也畫得出來 —— 錯得無聲無息。
///
/// 所以在資料夾裡壓一張「這批資料屬於哪個部署」的戳記，對不上就講清楚。
/// 這是這一輪第四個同類問題（伺服器快取、錯誤分類、瀏覽器憑證、本機紀錄），
/// 共通點都是「重新部署後還有東西記著舊地址」。

export const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
const STAMP = path.join(DATA_DIR, ".deployment.json");

/// 只納入「會決定帳戶或紀錄身分」的合約。poolFee、tickSpacing 這種參數改了不影響舊紀錄，
/// 納進來只會製造假警報。
const KEYS = [
  "accountFactory",
  "kycRegistry",
  "carbonRegistry",
  "carbonCredit1155",
  "retirementCertificate",
  "settlementToken",
  "listing",
] as const;

export type Stamp = { chainId: number; fingerprint: string; addresses: Record<string, string>; stampedAt: string };

export function deploymentFingerprint(): Stamp {
  const d = deployment() as unknown as Record<string, string>;
  const addresses: Record<string, string> = {};
  for (const k of KEYS) addresses[k] = String(d[k] ?? "").toLowerCase();
  const material = `${CHAIN_ID}|` + KEYS.map((k) => `${k}=${addresses[k]}`).join("|");
  const fingerprint = crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
  return { chainId: CHAIN_ID, fingerprint, addresses, stampedAt: new Date().toISOString() };
}

export class StaleDataError extends Error {
  readonly code = "DATA_STALE";
  constructor(readonly stamp: Stamp, readonly current: Stamp) {
    super(
      `web/data/ 裡的紀錄屬於另一個部署（資料 ${stamp.fingerprint} / chain ${stamp.chainId}，` +
        `目前 ${current.fingerprint} / chain ${current.chainId}）。` +
        `這些紀錄是用舊合約產生的帳戶地址當鍵的，在現在這條鏈上對不到任何帳戶。` +
        `確認舊資料不用了就執行 npm run data:reset（會先搬到 data.bak-<時間> 再重來），` +
        `或把 DATA_DIR 指到另一個資料夾分開存放。`,
    );
    this.name = "StaleDataError";
  }
}

function readStamp(): Stamp | undefined {
  try { return JSON.parse(fs.readFileSync(STAMP, "utf8")) as Stamp; } catch { return undefined; }
}

function writeStamp(s: Stamp) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STAMP, JSON.stringify(s, null, 2));
}

function hasRecords(): boolean {
  try {
    return fs.readdirSync(DATA_DIR).some((f) => f.endsWith(".json") && f !== ".deployment.json");
  } catch { return false; }
}

/// 驗過就記著，別讓每一次 all() 都去 stat 一輪。對不上時不快取：
/// 使用者清完資料就該立刻恢復，不必重啟伺服器。
let verified: string | undefined;
let adopted = false;

/// 資料夾與目前部署對不上就丟 StaleDataError。沒有戳記代表是舊版留下的資料夾
/// （戳記是後來才加的），這種情況補上戳記就好 —— 我們無從得知它屬於誰，
/// 硬擋只會讓既有環境打不開。
export function assertDataFresh(): void {
  const current = deploymentFingerprint();
  if (verified === current.fingerprint) return;
  const stamp = readStamp();
  if (!stamp) {
    if (hasRecords() && !adopted) {
      adopted = true;
      console.warn(`[data] web/data/ 沒有部署戳記，視為屬於目前部署 ${current.fingerprint}（chain ${current.chainId}）。若這些是舊鏈留下的紀錄，請執行 npm run data:reset。`);
    }
    writeStamp(current);
    verified = current.fingerprint;
    return;
  }
  if (stamp.fingerprint !== current.fingerprint) throw new StaleDataError(stamp, current);
  verified = current.fingerprint;
}

export function isStaleData(e: unknown): e is StaleDataError {
  return e instanceof StaleDataError || (e instanceof Error && e.name === "StaleDataError");
}
