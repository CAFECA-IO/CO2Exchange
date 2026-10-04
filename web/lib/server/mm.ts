import "server-only";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, normalizeConfig } from "@/scripts/mm/strategy.mjs";
import { ApiError } from "./api";
import { CHAIN_ID } from "./chain";
import { DATA_DIR } from "./fingerprint";

/// 後台做市：網站這一側。
///
/// 網站**只寫設定、讀狀態**，不持有做市帳戶的金鑰，也不送做市的交易——那是
/// `scripts/mm/mm.mjs` 這支常駐程式的事。兩邊透過 web/data/mm/ 底下的檔案溝通：
///   config.json   管理員在 /admin 寫、常駐程式每輪讀
///   status.json   常駐程式每輪寫、網站讀（心跳、部位、報價、警告）
///   accounts.json 常駐程式寫的做市帳戶地址（公開揭露與掛單簿標示用）
/// 讓網站能替做市帳戶簽字，等於讓攻進網站的人拿到做市資金。

export const MM_DIR = path.join(DATA_DIR, "mm");
const F = {
  config: path.join(MM_DIR, "config.json"),
  status: path.join(MM_DIR, "status.json"),
  accounts: path.join(MM_DIR, "accounts.json"),
  personas: path.join(DATA_DIR, "sim-personas.json"),
};

export type MmConfig = ReturnType<typeof normalizeConfig>["config"] & { updatedAt?: string; updatedBy?: string };

function readJson<T>(f: string): T | null {
  try { return JSON.parse(fs.readFileSync(f, "utf8")) as T; } catch { return null; }
}
function writeJson(f: string, v: unknown) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, f);
}

/// 模擬交易只准在這些鏈上開。常駐程式讀的是同一個變數，兩邊各擋一次。
export function simulationChains(): number[] {
  return String(process.env.SIMULATION_CHAINS ?? "31337,1337,8018,18018").split(",").map((x) => Number(x.trim())).filter(Boolean);
}
export const simulationAllowed = () => simulationChains().includes(CHAIN_ID);

export function readConfig(): MmConfig {
  const raw = readJson<Record<string, unknown>>(F.config);
  const { config } = normalizeConfig(raw ?? {});
  return { ...config, updatedAt: raw?.updatedAt as string | undefined, updatedBy: raw?.updatedBy as string | undefined };
}

/// 合併後整份重寫。不合法的欄位直接拒絕（不是悄悄換成預設值）——
/// 管理員按了儲存，就該知道存進去的是不是他填的。
export function writeConfig(patch: Record<string, unknown>, by: string): MmConfig {
  const cur = readConfig();
  const merged = {
    ...cur, ...patch,
    simulation: { ...cur.simulation, ...((patch.simulation as object | undefined) ?? {}) },
    commands: { ...cur.commands, ...((patch.commands as object | undefined) ?? {}) },
  };
  const { config, problems } = normalizeConfig(merged);
  if (problems.length) throw new ApiError("INVALID_PARAM", problems.join("；"), { problems });
  if (config.simulation.enabled && !simulationAllowed()) {
    throw new ApiError("FORBIDDEN", `chainId ${CHAIN_ID} 不是測試鏈（SIMULATION_CHAINS=${simulationChains().join(",")}），不能開模擬交易`);
  }
  const out = { ...config, updatedAt: new Date().toISOString(), updatedBy: by };
  writeJson(F.config, out);
  return out;
}

export type MmStatus = Record<string, unknown> & { heartbeatAt?: string; intervalSec?: number; chainId?: number };

/// 狀態加上「常駐程式是不是還活著」。心跳超過三輪（至少三分鐘）沒更新就算停了——
/// 狀態檔本身不會自己變舊，畫面上看起來一切正常，其實後面已經沒有人在報價。
export function readStatus(): { status: MmStatus | null; alive: boolean; ageSec: number | null; sameChain: boolean } {
  const status = readJson<MmStatus>(F.status);
  if (!status?.heartbeatAt) return { status, alive: false, ageSec: null, sameChain: false };
  const ageSec = Math.round((Date.now() - Date.parse(status.heartbeatAt)) / 1000);
  const limit = Math.max(180, 3 * Number(status.intervalSec ?? 60) + 120);
  return { status, alive: ageSec <= limit, ageSec, sameChain: status.chainId === CHAIN_ID };
}

export type ParticipantTag = "mm" | "sim" | "op";

let cache: { at: number; tags: Map<string, ParticipantTag> } | null = null;
/// 地址 → 標示。掛單簿與揭露頁用它標出「平台做市」與「模擬」。
///
/// 模擬人物只在測試鏈上標示：正式鏈上不會有模擬人物，就算磁碟上留著一份舊名冊也不該套用。
export function participantTags(): Map<string, ParticipantTag> {
  if (cache && Date.now() - cache.at < 10_000) return cache.tags;
  const tags = new Map<string, ParticipantTag>();
  if (simulationAllowed()) {
    const r = readJson<{ chainId?: number; personas?: { address?: string }[]; addressSpace?: string[] }>(F.personas);
    if (r && (r.chainId === undefined || r.chainId === CHAIN_ID)) {
      for (const p of r.personas ?? []) if (p.address) tags.set(p.address.toLowerCase(), "sim");
      for (const addr of r.addressSpace ?? []) tags.set(addr.toLowerCase(), "sim");
    }
  }
  const a = readJson<{ chainId?: number; marketMakers?: string[]; platform?: string[] }>(F.accounts);
  if (a?.chainId === CHAIN_ID) {
    // 營運金鑰自己掛的單（例如平台把託管的國外額度放到市場上）也是平台的單
    for (const m of a.platform ?? []) tags.set(m.toLowerCase(), "op");
    for (const m of a.marketMakers ?? []) tags.set(m.toLowerCase(), "mm");
  }
  cache = { at: Date.now(), tags };
  return tags;
}
export const tagOf = (addr: string): ParticipantTag | null => participantTags().get(addr.toLowerCase()) ?? null;

/// 公開揭露：做市帳戶是誰、正在報什麼價、規則是什麼。不含資金與損益（那是營運資訊）。
export function disclosure() {
  const { status, alive, sameChain } = readStatus();
  const a = readJson<{ chainId?: number; marketMakers?: string[]; platform?: string[]; simulationActive?: boolean }>(F.accounts);
  const makers = a?.chainId === CHAIN_ID ? a.marketMakers ?? [] : [];
  const platform = a?.chainId === CHAIN_ID ? a.platform ?? [] : [];
  const quoting = !!(alive && sameChain && status && (status as { action?: string }).action?.match(/^(quoting|requoted)/));
  const quotes = (status?.quotes as { bids?: unknown[]; asks?: unknown[] } | undefined) ?? {};
  return {
    marketMakers: makers,
    platformAccounts: platform,
    quoting,
    bidLevels: quoting ? (quotes.bids?.length ?? 0) : 0,
    askLevels: quoting ? (quotes.asks?.length ?? 0) : 0,
    simulation: {
      allowedOnThisChain: simulationAllowed(),
      active: simulationAllowed() && alive && sameChain && !!a?.simulationActive,
      simulatedAccounts: simulationAllowed() ? (readJson<{ personas?: unknown[] }>(F.personas)?.personas?.length ?? 0) : 0,
    },
    rules: [
      "做市帳戶只被動報價（掛買單與賣單），不主動吃任何人的單。",
      "做市帳戶不與平台控制的任何帳戶成交：其他做市帳戶、營運金鑰、模擬人物。",
      "做市帳戶的買價一定低於簿子上最佳賣價、賣價一定高於最佳買價，不製造交叉。",
      "做市資金由平台撥付，有撥款、持有部位、單筆與單日停損上限；碰到停損即撤回全部報價。",
      "模擬交易只在測試鏈上執行，模擬人物的掛單在掛單簿上標示為「模擬」。",
      "營運方自己的掛單（例如把託管的國外額度放到市場上）標示為「平台自營」。",
    ],
  };
}

export { DEFAULT_CONFIG };
