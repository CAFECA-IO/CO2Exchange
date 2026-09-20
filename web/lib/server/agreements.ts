import "server-only";
import fs from "node:fs";
import path from "node:path";
import { keccak256, toBytes } from "viem";
import { all, insert, type WithId } from "./store";

/// 定型化契約：檔案是唯一真相，雜湊由內容算出來。
///
/// 為什麼不把條文存資料庫：契約要能被第三方驗證「我當時同意的是哪一版」。
/// 條文放版控的 markdown，keccak256(檔案內容) 就是版本指紋，
/// 同意紀錄只存指紋。日後爭執時把檔案拿出來重算即可比對，不必相信平台的資料庫。

const DIR = process.env.AGREEMENTS_DIR ?? path.resolve(process.cwd(), "contracts");

export type AgreementMeta = {
  id: string;
  title: string;
  version: string;
  effectiveDate: string;
  summary: string;
  hash: `0x${string}`;
  /// 誰要簽這份
  parties: string;
};

export type Agreement = AgreementMeta & { body: string };

/// 四份契約的角色。順序就是使用者會遇到的順序。
const ROLES: Record<string, string> = {
  "platform-terms": "所有使用者（建立帳戶時）",
  "service-flow": "所有使用者（平台使用約定書之附件，不另行簽署）",
  "service-fee": "專案開發者 / 賣方（委託代辦時）",
  "trade-agreement": "買方與賣方（每筆交易）",
  "retirement-mandate": "註銷人（每次註銷，限具額度帳戶之事業）",
};
export const AGREEMENT_ORDER = ["platform-terms", "service-flow", "service-fee", "trade-agreement", "retirement-mandate"] as const;

/// 極簡 frontmatter 解析。條文檔是我們自己寫的，格式固定，不值得為它拉一個 YAML 相依。
function parse(file: string): Agreement {
  const raw = fs.readFileSync(file, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`${path.basename(file)} 缺少 frontmatter`);
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const id = meta.id ?? path.basename(file, ".md");
  return {
    id,
    title: meta.title ?? id,
    version: meta.version ?? "v0",
    effectiveDate: meta.effectiveDate ?? "",
    summary: meta.summary ?? "",
    parties: ROLES[id] ?? "",
    // 雜湊算整個檔案（含 frontmatter）：版本號改了、內容沒改，也算不同版本。
    hash: keccak256(toBytes(raw)),
    body: m[2],
  };
}

let cache: { mtimes: string; value: Agreement[] } | undefined;

export function agreements(): Agreement[] {
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".md")) : [];
  const key = files.map((f) => `${f}:${fs.statSync(path.join(DIR, f)).mtimeMs}`).join("|");
  if (cache?.mtimes === key) return cache.value;
  const value = files
    .map((f) => parse(path.join(DIR, f)))
    .sort((a, b) => AGREEMENT_ORDER.indexOf(a.id as never) - AGREEMENT_ORDER.indexOf(b.id as never));
  cache = { mtimes: key, value };
  return value;
}

/// 列表只給中繼資料，條文另外要
function stripBody(a: Agreement): AgreementMeta {
  const { body, ...meta } = a;
  void body;
  return meta;
}

export function agreementMetas(): AgreementMeta[] {
  return agreements().map(stripBody);
}

export function agreement(id: string): Agreement | undefined {
  return agreements().find((a) => a.id === id);
}

export type Acceptance = WithId & {
  account: string;
  email: string;
  docId: string;
  version: string;
  hash: string;
  /// 消保法第 11-1 條的審閱期：介面開啟條文的時間，用來證明有給看。
  reviewStartedAt?: string;
  context?: string; // 例如 order:12
};

export function acceptancesOf(account: string): Acceptance[] {
  const a = account.toLowerCase();
  return all<Acceptance>("agreement-acceptances").filter((r) => r.account.toLowerCase() === a);
}

/// 目前有效版本是否都已簽署。版本換了就要重簽——這正是雜湊存在的理由。
export function missingAgreements(account: string, ids: readonly string[]): AgreementMeta[] {
  const signed = new Set(acceptancesOf(account).map((r) => `${r.docId}@${r.hash}`));
  return agreements()
    .filter((a) => ids.includes(a.id) && !signed.has(`${a.id}@${a.hash}`))
    .map(stripBody);
}

export function recordAcceptance(row: Omit<Acceptance, keyof WithId>): Acceptance {
  return insert<Acceptance>("agreement-acceptances", row);
}
