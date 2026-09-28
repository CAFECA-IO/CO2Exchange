import type { Address, Hex } from "viem";
import { payloadHash, type Event, type EventOf } from "./events.ts";

/// 帳本引擎 v2：一串事件 → 登錄簿、身分、持有、掛單簿、成交、憑證、對帳報告。
///
/// **純函式**：同一串事件，任何人跑都得出同一個狀態。可重播的約束沿用 v1（見 lib/bank/engine.ts）：
/// 不讀時鐘（時間只來自事件的 `at`）、不用亂數、不依賴 Map 迭代順序（用之前明確排序）、
/// 整數運算、規則版本化（`RULES_VERSION` 進每一期的承諾）。
///
/// ## 原本由合約守的規則，現在在這裡
///
/// 鏈上沒有登錄簿之後，`KYCRegistry.checkTransfer`、`CarbonRegistry.checkTradable`、
/// `checkRetirePurpose`、自然人政策……全部搬進引擎。這是**保證的降級**：從「合約拒絕」
/// 變成「重播抓得到」。每一條都盡量照原本合約的語意移植，差異在註解裡寫明。
///
/// ## 簽章不在這裡驗
///
/// 驗簽要查鏈（授權清單、ERC-1271 帳戶在當時的金鑰），不是純計算。重播先做一輪驗簽，
/// 把結果交給引擎（`ctx.sigOk`）；引擎只負責「驗不過就以同一個理由拒絕」。

export const RULES_VERSION = 2;
const KG_PER_TONNE = 1000n;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const DOMESTIC = "TW";

export type Jurisdiction = { country: string; enabled: boolean; domestic: boolean; purposeMask: number; name: string; scheme: string; registryName: string; note: string };
export type Identity = { account: Address; tier: number; expiry: bigint; jurisdiction: string; identityHash: Hex; frozen: boolean; attNonce: bigint };
export type Project = { id: bigint; owner: Address; name: string; methodology: string; location: string; metadataURI: string; active: boolean; country: string; scheme: string; atSeq: bigint };
export type Batch = {
  id: bigint; projectId: bigint; monitoringStart: bigint; monitoringEnd: bigint; vintageYear: number;
  serialHash: Hex; reportHash: Hex; verifier: Address; issuedAt: bigint; issuedKg: bigint; retiredKg: bigint; frozen: boolean; atSeq: bigint;
};
export type Certificate = {
  id: bigint; batchId: bigint; account: Address; amountKg: bigint; beneficiary: string; beneficiaryHash: Hex; purpose: number; memo: string;
  retiredAt: bigint; country: string; scheme: string; fee: bigint; atSeq: bigint; documentHash: Hex | null; officialRef: string; officialAt: bigint;
};
export type ReserveReport = {
  id: bigint; period: number; asOf: bigint; contentHash: Hex; documentHash: Hex; publisher: Address; publishedAt: bigint; atSeq: bigint;
  status: number; auditor: Address; auditorName: string; note: string; attestedAt: bigint;
  credits: EventOf<"reserveReport">["credits"]; cash: EventOf<"reserveReport">["cash"];
};

export type Order = {
  seq: bigint; account: Address; side: "buy" | "sell"; batchId: bigint; country: string;
  amountKg: bigint; remainingKg: bigint; pricePerTonne: bigint; minFillKg: bigint; expiry: bigint; placedAt: bigint;
  /// 買單還鎖著多少結算幣。逐筆記，不用「剩餘量 × 單價」回推——兩者會因捨去差幾個最小單位，
  /// 而那幾個最小單位要嘛變成沒有人領得走的零頭，要嘛讓鎖定變成負數。
  locked: bigint;
};
export type Fill = {
  atSeq: bigint; at: bigint; buyer: Address; seller: Address; batchId: bigint; country: string;
  amountKg: bigint; pricePerTonne: bigint; cost: bigint; fee: bigint; makerSeq: bigint; takerSeq: bigint;
};

export type State = {
  rulesVersion: number;
  jurisdictions: Map<string, Jurisdiction>;
  policy: { individualTransfer: boolean; individualRetire: boolean; treasury: Address };
  fees: { tradeBps: bigint; retireFeePerTonne: bigint; byCountry: Map<string, { tradeBps: bigint; retireFeePerTonne: bigint }> };
  identities: Map<string, Identity>;
  projects: Map<string, Project>;
  nextProjectId: bigint;
  batches: Map<string, Batch>;
  nextBatchId: bigint;
  serialUsed: Set<string>;
  attestationUsed: Set<string>;
  certificates: Map<string, Certificate>;
  nextCertId: bigint;
  reports: Map<string, ReserveReport>;
  nextReportId: bigint;
  /// account → batchId → kg（可動用）
  credits: Map<string, Map<string, bigint>>;
  cash: Map<string, bigint>;
  lockedCredits: Map<string, Map<string, bigint>>;
  lockedCash: Map<string, bigint>;
  book: Map<string, Order>;
  fills: Fill[];
  /// 手續費收入。餘額樹把它算在 policy.treasury 名下。
  treasuryCash: bigint;
  /// 使用者簽章的 nonce（掛單、撤單、註銷、登錄專案共用一條），嚴格遞增。
  nonces: Map<string, bigint>;
  /// 被拒絕的事件。**不是錯誤**：重播時必須以同樣的理由被拒絕。
  rejected: { seq: bigint; kind: string; reason: string }[];
  lastSeq: bigint;
  lastAt: bigint;
};

export type Context = {
  /// 這一筆的簽章驗過了嗎（由重播的驗簽階段給）。鏈上鏡像事件不看這個。
  sigOk: (seq: bigint) => boolean;
};

const lower = (a: string) => a.toLowerCase();
const get2 = (m: Map<string, Map<string, bigint>>, a: string, b: string) => m.get(a)?.get(b) ?? 0n;
function add2(m: Map<string, Map<string, bigint>>, a: string, b: string, v: bigint) {
  const inner = m.get(a) ?? m.set(a, new Map()).get(a)!;
  const next = (inner.get(b) ?? 0n) + v;
  if (next === 0n) inner.delete(b); else inner.set(b, next);
  if (inner.size === 0) m.delete(a);
}
function add1(m: Map<string, bigint>, k: string, v: bigint) {
  const next = (m.get(k) ?? 0n) + v;
  if (next === 0n) m.delete(k); else m.set(k, next);
}

/// 名目金額：公斤 × 每噸單價 ÷ 1000，**無條件捨去**（方向固定，兩份實作才對得上）。
export const notional = (kg: bigint, pricePerTonne: bigint): bigint => (kg * pricePerTonne) / KG_PER_TONNE;

/// 創世狀態。對應原本 `CarbonRegistry` 建構子一開始就登錄的母國，以及各合約的初始政策。
/// 它是規則的一部分（改了就是新的 RULES_VERSION），所以寫死在這裡，不從設定檔讀。
export function genesis(): State {
  return {
    rulesVersion: RULES_VERSION,
    jurisdictions: new Map([[DOMESTIC, {
      country: DOMESTIC, enabled: true, domestic: true, purposeMask: 0x0f,
      name: "臺灣", scheme: "TCER", registryName: "溫室氣體減量額度管理系統",
      note: "國內減量額度，四種用途皆可；碳費扣除上限為收費排放量 10%，自願減量專案額度扣除比率 1.2",
    }]]),
    // 自然人可以轉售（他持有的本來就是請求權），但不能註銷（官方端沒有他的額度帳戶）。
    policy: { individualTransfer: true, individualRetire: false, treasury: ZERO },
    fees: { tradeBps: 100n, retireFeePerTonne: 0n, byCountry: new Map() },
    identities: new Map(), projects: new Map(), nextProjectId: 1n,
    batches: new Map(), nextBatchId: 1n, serialUsed: new Set(), attestationUsed: new Set(),
    certificates: new Map(), nextCertId: 1n, reports: new Map(), nextReportId: 1n,
    credits: new Map(), cash: new Map(), lockedCredits: new Map(), lockedCash: new Map(),
    book: new Map(), fills: [], treasuryCash: 0n, nonces: new Map(), rejected: [], lastSeq: 0n, lastAt: 0n,
  };
}

/// 一次套用一串事件（必須依 seq 排好、連號）。
export function apply(state: State, events: Event[], ctx: Context): State {
  for (const e of events) {
    if (e.seq !== state.lastSeq + 1n) throw new Error(`事件不連號：目前到第 ${state.lastSeq} 筆，下一筆是第 ${e.seq} 筆`);
    // 時間不得倒退。倒退的話「過期」的判斷會隨事件順序改變，而那不是規則該有的樣子。
    if (e.at < state.lastAt) throw new Error(`第 ${e.seq} 筆的時間 ${e.at} 早於前一筆 ${state.lastAt}`);
    step(state, e, ctx);
    state.lastSeq = e.seq;
    state.lastAt = e.at;
  }
  return state;
}

const reject = (s: State, e: Event, reason: string) => { s.rejected.push({ seq: e.seq, kind: e.kind, reason }); };

// ── 身分與政策的判斷（對應 KYCRegistry 的 _active / checkTransfer / checkRetire）──

export function isActive(s: State, account: string, at: bigint): boolean {
  const id = s.identities.get(lower(account));
  return !!id && id.tier !== 0 && !id.frozen && id.expiry > at;
}
const tierOf = (s: State, account: string) => s.identities.get(lower(account))?.tier ?? 0;

export function countryOfBatch(s: State, batchId: bigint): string | null {
  const b = s.batches.get(String(batchId));
  if (!b) return null;
  return s.projects.get(String(b.projectId))?.country ?? null;
}
function tradable(s: State, batchId: bigint): string | null {
  const b = s.batches.get(String(batchId));
  if (!b) return "找不到這個批次";
  if (b.frozen) return "批次已凍結";
  const c = countryOfBatch(s, batchId);
  const j = c ? s.jurisdictions.get(c) : undefined;
  if (!j) return "未知的轄區";
  if (!j.enabled) return "轄區已關閉交易";
  return null;
}
export function tradeBpsOf(s: State, country: string): bigint {
  return s.fees.byCountry.get(country)?.tradeBps ?? s.fees.tradeBps;
}
export function retireFeeOf(s: State, country: string, kg: bigint): bigint {
  const perTonne = s.fees.byCountry.get(country)?.retireFeePerTonne ?? s.fees.retireFeePerTonne;
  return (perTonne * kg) / KG_PER_TONNE;
}
/// 使用者簽章的 nonce 必須嚴格遞增。
function takeNonce(s: State, account: Address, nonce: bigint): boolean {
  const a = lower(account);
  if (nonce <= (s.nonces.get(a) ?? 0n)) return false;
  s.nonces.set(a, nonce);
  return true;
}

function step(s: State, e: Event, ctx: Context): void {
  // 鏈上鏡像事件由 ChainRef 背書；其餘一律先看簽章。
  if (e.kind !== "cashDeposit" && e.kind !== "cashWithdraw" && !ctx.sigOk(e.seq)) return reject(s, e, "簽章或授權無效");

  switch (e.kind) {
    case "cashDeposit":
      add1(s.cash, lower(e.account), e.amount);
      return;
    case "cashWithdraw": {
      // 提領已經在鏈上發生了（合約憑證據放款）。帳本對不上就記下來——這是要查的事，不是可以默默吞掉的事。
      const a = lower(e.account);
      if ((s.cash.get(a) ?? 0n) < e.amount) return reject(s, e, "帳本餘額少於鏈上提領金額");
      add1(s.cash, a, -e.amount);
      return;
    }
    case "jurisdiction":
      if (!/^[A-Z]{2}$/.test(e.country)) return reject(s, e, "轄區代碼必須是兩個大寫字母");
      s.jurisdictions.set(e.country, {
        country: e.country, enabled: e.enabled, domestic: e.domestic, purposeMask: e.purposeMask & 0xff,
        name: e.name, scheme: e.scheme, registryName: e.registryName, note: e.note,
      });
      return;
    case "policy":
      s.policy = { individualTransfer: e.individualTransfer, individualRetire: e.individualRetire, treasury: e.treasury };
      return;
    case "fees":
      if (e.tradeBps > 500n) return reject(s, e, "交易手續費上限 500 bps");
      if (e.country === "") { s.fees.tradeBps = e.tradeBps; s.fees.retireFeePerTonne = e.retireFeePerTonne; }
      else s.fees.byCountry.set(e.country, { tradeBps: e.tradeBps, retireFeePerTonne: e.retireFeePerTonne });
      return;
    case "identity":
      return doIdentity(s, e);
    case "freeze":
      return doFreeze(s, e);
    case "project":
      return doProject(s, e);
    case "importProject": {
      const j = s.jurisdictions.get(e.country);
      if (!j) return reject(s, e, "未知的轄區");
      if (!j.enabled) return reject(s, e, "轄區已關閉");
      addProject(s, e, e.owner, e.country, e.scheme);
      return;
    }
    case "projectStatus": {
      const p = s.projects.get(String(e.projectId));
      if (!p) return reject(s, e, "找不到這個專案");
      p.active = e.active;
      return;
    }
    case "issue":
      return doIssue(s, e);
    case "place":
      return doPlace(s, e);
    case "cancel":
      return doCancel(s, e);
    case "retire":
      return doRetire(s, e);
    case "certDocument": {
      const c = s.certificates.get(String(e.certId));
      if (!c) return reject(s, e, "找不到這張憑證");
      // 回寫之後不能改：PDF 一旦被人拿去申報，雜湊就不能換
      if (c.documentHash) return reject(s, e, "文件雜湊已回寫，不能更改");
      c.documentHash = e.documentHash;
      return;
    }
    case "certOfficial": {
      const c = s.certificates.get(String(e.certId));
      if (!c) return reject(s, e, "找不到這張憑證");
      if (c.officialRef) return reject(s, e, "官方註銷編號已回填");
      c.officialRef = e.officialRef; c.officialAt = e.officialAt;
      return;
    }
    case "reserveReport": {
      if (e.credits.length === 0) return reject(s, e, "對帳報告沒有任何額度列");
      const id = s.nextReportId++;
      s.reports.set(String(id), {
        id, period: e.period, asOf: e.asOf, contentHash: payloadHash(e), documentHash: e.documentHash,
        publisher: e.signer, publishedAt: e.at, atSeq: e.seq, status: 0, auditor: ZERO, auditorName: "", note: "", attestedAt: 0n,
        credits: e.credits, cash: e.cash,
      });
      return;
    }
    case "reserveAttest": {
      const r = s.reports.get(String(e.reportId));
      if (!r) return reject(s, e, "找不到這份報告");
      if (r.status !== 0) return reject(s, e, "報告已經簽署過");
      if (e.status !== 1 && e.status !== 2) return reject(s, e, "查核結果只能是相符或有差異");
      r.status = e.status; r.auditor = e.signer; r.auditorName = e.auditorName; r.note = e.note; r.attestedAt = e.at;
      return;
    }
  }
}

function doIdentity(s: State, e: EventOf<"identity">) {
  if (e.tier !== 1 && e.tier !== 2) return reject(s, e, "身分等級只能是自然人或法人");
  if (e.at > e.deadline) return reject(s, e, "身分證明已過期");
  const a = lower(e.account);
  const cur = s.identities.get(a);
  if (e.nonce !== (cur?.attNonce ?? 0n)) return reject(s, e, "身分證明的 nonce 不對");
  // 凍結狀態不因重新驗證而解除（和 KYCRegistry 相同）
  s.identities.set(a, {
    account: e.account, tier: e.tier, expiry: e.expiry, jurisdiction: e.jurisdiction, identityHash: e.identityHash,
    frozen: cur?.frozen ?? false, attNonce: (cur?.attNonce ?? 0n) + 1n,
  });
}

function doFreeze(s: State, e: EventOf<"freeze">) {
  if (e.target === 0) {
    const id = s.identities.get(lower(e.account));
    if (!id) return reject(s, e, "這個帳戶沒有身分紀錄");
    id.frozen = e.frozen;
    // 凍結的帳戶不能繼續掛著單：把他的單撤掉，鎖住的東西還給他（仍在他名下，只是不能動）
    if (e.frozen) for (const o of sortedBook(s)) if (lower(o.account) === lower(e.account)) { release(s, o); s.book.delete(String(o.seq)); }
    return;
  }
  if (e.target === 1) {
    const b = s.batches.get(String(e.batchId));
    if (!b) return reject(s, e, "找不到這個批次");
    b.frozen = e.frozen;
    if (e.frozen) for (const o of sortedBook(s)) if (o.side === "sell" && o.batchId === e.batchId) { release(s, o); s.book.delete(String(o.seq)); }
    return;
  }
  reject(s, e, "凍結對象只能是帳戶或批次");
}

function addProject(s: State, e: Event, owner: Address, country: string, scheme: string) {
  const p = e as EventOf<"project"> | EventOf<"importProject">;
  const id = s.nextProjectId++;
  s.projects.set(String(id), {
    id, owner, name: p.name, methodology: p.methodology, location: p.location, metadataURI: p.metadataURI,
    active: true, country, scheme, atSeq: e.seq,
  });
}

function doProject(s: State, e: EventOf<"project">) {
  if (!takeNonce(s, e.account, e.nonce)) return reject(s, e, "nonce 不遞增");
  // 國內專案只能由有效的法人登錄（CarbonRegistry.registerProject 的規則）
  if (tierOf(s, e.account) !== 2 || !isActive(s, e.account, e.at)) return reject(s, e, "只有有效的法人可以登錄專案");
  addProject(s, e, e.account, DOMESTIC, "TCER");
}

function doIssue(s: State, e: EventOf<"issue">) {
  const p = s.projects.get(String(e.projectId));
  if (!p) return reject(s, e, "找不到這個專案");
  if (!p.active) return reject(s, e, "專案已停用");
  if (e.at > e.deadline) return reject(s, e, "核發證明已過期");
  if (e.monitoringEnd <= e.monitoringStart) return reject(s, e, "監測期間不合理");
  if (e.amountKg <= 0n) return reject(s, e, "核發量要大於零");
  if (s.serialUsed.has(e.serialHash.toLowerCase())) return reject(s, e, "序號已使用");
  const attKey = `${lower(e.signer)}|${e.attestationId}`;
  if (s.attestationUsed.has(attKey)) return reject(s, e, "這份查驗證明已使用");
  s.serialUsed.add(e.serialHash.toLowerCase());
  s.attestationUsed.add(attKey);
  const id = s.nextBatchId++;
  s.batches.set(String(id), {
    id, projectId: e.projectId, monitoringStart: e.monitoringStart, monitoringEnd: e.monitoringEnd,
    vintageYear: new Date(Number(e.monitoringEnd) * 1000).getUTCFullYear(),
    serialHash: e.serialHash, reportHash: e.reportHash, verifier: e.signer, issuedAt: e.at,
    issuedKg: e.amountKg, retiredKg: 0n, frozen: false, atSeq: e.seq,
  });
  add2(s.credits, lower(p.owner), String(id), e.amountKg);
}

function sortedBook(s: State): Order[] {
  return [...s.book.values()].sort((x, y) => (x.seq < y.seq ? -1 : x.seq > y.seq ? 1 : 0));
}

/// 撤單或成交完時，把鎖住的東西放回可動用餘額。
function release(s: State, o: Order): void {
  const a = lower(o.account);
  if (o.side === "sell") {
    add2(s.lockedCredits, a, String(o.batchId), -o.remainingKg);
    add2(s.credits, a, String(o.batchId), o.remainingKg);
  } else {
    add1(s.lockedCash, a, -o.locked);
    add1(s.cash, a, o.locked);
    o.locked = 0n;
  }
}

function doCancel(s: State, e: EventOf<"cancel">) {
  if (!takeNonce(s, e.account, e.nonce)) return reject(s, e, "nonce 不遞增");
  const o = s.book.get(String(e.orderSeq));
  if (!o) return reject(s, e, "找不到這張單");
  if (lower(o.account) !== lower(e.account)) return reject(s, e, "不是自己的單");
  // 撤單不檢查身分：那是他自己鎖住的東西，身分過期也該拿得回來（和 cancelBid 相同）
  release(s, o);
  s.book.delete(String(e.orderSeq));
}

function doPlace(s: State, e: EventOf<"place">) {
  if (!takeNonce(s, e.account, e.nonce)) return reject(s, e, "nonce 不遞增");
  if (e.amountKg <= 0n || e.pricePerTonne <= 0n) return reject(s, e, "數量與價格要大於零");
  if (e.minFillKg < 0n || e.minFillKg > e.amountKg) return reject(s, e, "最小成交量不合理");
  if (e.expiry <= e.at) return reject(s, e, "有效期限已過");
  if (!isActive(s, e.account, e.at)) return reject(s, e, "帳戶身分無效、已過期或已凍結");
  const a = lower(e.account);

  if (e.side === "sell") {
    const bad = tradable(s, e.batchId);
    if (bad) return reject(s, e, bad);
    // 自然人轉售政策（KYCRegistry.checkTransfer 的 individualTransferEnabled）
    if (tierOf(s, e.account) === 1 && !s.policy.individualTransfer) return reject(s, e, "目前不開放自然人轉售");
    if (get2(s.credits, a, String(e.batchId)) < e.amountKg) return reject(s, e, "碳權餘額不足");
    add2(s.credits, a, String(e.batchId), -e.amountKg);
    add2(s.lockedCredits, a, String(e.batchId), e.amountKg);
  } else {
    if (e.batchId !== 0n) {
      const bad = tradable(s, e.batchId);
      if (bad) return reject(s, e, bad);
    }
    if (e.country) {
      const j = s.jurisdictions.get(e.country);
      if (!j) return reject(s, e, "未知的轄區");
      if (!j.enabled) return reject(s, e, "轄區已關閉交易");
    }
    const need = notional(e.amountKg, e.pricePerTonne);
    if ((s.cash.get(a) ?? 0n) < need) return reject(s, e, "結算幣餘額不足");
    add1(s.cash, a, -need);
    add1(s.lockedCash, a, need);
  }
  const locked = e.side === "buy" ? notional(e.amountKg, e.pricePerTonne) : 0n;

  const order: Order = {
    seq: e.seq, account: e.account, side: e.side, batchId: e.batchId,
    country: e.side === "sell" ? (countryOfBatch(s, e.batchId) ?? "") : e.country,
    amountKg: e.amountKg, remainingKg: e.amountKg, pricePerTonne: e.pricePerTonne, minFillKg: e.minFillKg,
    expiry: e.expiry, placedAt: e.at, locked,
  };
  match(s, order, e.at, e.seq);
  if (order.remainingKg > 0n) s.book.set(String(order.seq), order);
}

/// 賣單 × 買單能不能配：批次、核發國都要對得上。
function compatible(s: State, sell: Order, buy: Order): boolean {
  if (buy.batchId !== 0n && buy.batchId !== sell.batchId) return false;
  if (buy.country && buy.country !== sell.country) return false;
  return true;
}

/// 成交當下還能不能交易。掛單之後可能被凍結、身分過期、批次被凍結、轄區被關——
/// 這些在原本的合約是每一次移轉都檢查的（`_update`），所以這裡也每一筆都檢查。
function eligible(s: State, o: Order, now: bigint): boolean {
  if (o.expiry <= now) return false;
  if (!isActive(s, o.account, now)) return false;
  if (o.side === "sell") {
    if (tradable(s, o.batchId)) return false;
    if (tierOf(s, o.account) === 1 && !s.policy.individualTransfer) return false;
  }
  return true;
}

function candidates(s: State, taker: Order, now: bigint): Order[] {
  const want = taker.side === "buy" ? "sell" : "buy";
  const out: Order[] = [];
  for (const o of s.book.values()) {
    if (o.side !== want) continue;
    if (lower(o.account) === lower(taker.account)) continue; // 不自成交
    if (!eligible(s, o, now)) continue;
    const [sell, buy] = want === "sell" ? [o, taker] : [taker, o];
    if (!compatible(s, sell, buy)) continue;
    if (taker.side === "buy" ? o.pricePerTonne > taker.pricePerTonne : o.pricePerTonne < taker.pricePerTonne) continue;
    out.push(o);
  }
  // 價格優先、序號其次——撮合規則的一部分，不是實作細節
  out.sort((x, y) => {
    if (x.pricePerTonne !== y.pricePerTonne) {
      return want === "sell" ? (x.pricePerTonne < y.pricePerTonne ? -1 : 1) : (x.pricePerTonne > y.pricePerTonne ? -1 : 1);
    }
    return x.seq < y.seq ? -1 : x.seq > y.seq ? 1 : 0;
  });
  return out;
}

function match(s: State, taker: Order, now: bigint, atSeq: bigint): void {
  for (const maker of candidates(s, taker, now)) {
    if (taker.remainingKg === 0n) break;
    const amount = taker.remainingKg < maker.remainingKg ? taker.remainingKg : maker.remainingKg;
    if (amount <= 0n) continue;
    if (amount < maker.minFillKg && amount !== maker.remainingKg) continue;
    if (amount < taker.minFillKg && amount !== taker.remainingKg) continue;

    const price = maker.pricePerTonne; // 成交價以簿子上那一張為準
    const buy = taker.side === "buy" ? taker : maker;
    const sell = taker.side === "buy" ? maker : taker;
    const cost = notional(amount, price);
    const fee = (cost * tradeBpsOf(s, sell.country)) / 10_000n; // 手續費由賣方承擔（和 Listing 相同）
    const b = lower(buy.account), se = lower(sell.account);

    // 買方的錢從這張買單自己的鎖定裡出。全部成交的那一筆把剩下的鎖定全拿出來，捨去的零頭一併退回。
    const last = buy.remainingKg === amount;
    const part = last ? buy.locked : notional(amount, buy.pricePerTonne);
    buy.locked -= part;
    add1(s.lockedCash, b, -part);
    if (part > cost) add1(s.cash, b, part - cost);
    add2(s.lockedCredits, se, String(sell.batchId), -amount);
    add2(s.credits, b, String(sell.batchId), amount);
    add1(s.cash, se, cost - fee);
    s.treasuryCash += fee;

    taker.remainingKg -= amount;
    maker.remainingKg -= amount;
    if (maker.remainingKg === 0n) s.book.delete(String(maker.seq));
    s.fills.push({
      atSeq, at: now, buyer: buy.account, seller: sell.account, batchId: sell.batchId, country: sell.country,
      amountKg: amount, pricePerTonne: price, cost, fee, makerSeq: maker.seq, takerSeq: taker.seq,
    });
  }
}

function doRetire(s: State, e: EventOf<"retire">) {
  if (!takeNonce(s, e.account, e.nonce)) return reject(s, e, "nonce 不遞增");
  if (e.amountKg <= 0n) return reject(s, e, "註銷量要大於零");
  const id = s.identities.get(lower(e.account));
  // KYCRegistry.checkRetire：凍結擋、沒有身分擋、自然人依政策；**到期不擋**（註銷對任何人無害）
  if (!id || id.tier === 0) return reject(s, e, "沒有身分紀錄");
  if (id.frozen) return reject(s, e, "帳戶已凍結");
  if (id.tier === 1 && !s.policy.individualRetire) return reject(s, e, "自然人不能註銷（官方登錄簿沒有自然人的額度帳戶）");
  const b = s.batches.get(String(e.batchId));
  if (!b) return reject(s, e, "找不到這個批次");
  if (b.frozen) return reject(s, e, "批次已凍結");
  const country = countryOfBatch(s, e.batchId) ?? "";
  const j = s.jurisdictions.get(country);
  if (!j) return reject(s, e, "未知的轄區");
  // 用途 × 轄區：國外額度不能做增量抵換或環評承諾（氣候變遷因應法第 27 條）
  if (e.purpose < 0 || e.purpose > 7 || (j.purposeMask & (1 << e.purpose)) === 0) return reject(s, e, "這個轄區的額度不能用於這個用途");
  const a = lower(e.account);
  if (get2(s.credits, a, String(e.batchId)) < e.amountKg) return reject(s, e, "碳權餘額不足");
  const fee = retireFeeOf(s, country, e.amountKg);
  if ((s.cash.get(a) ?? 0n) < fee) return reject(s, e, "結算幣不足以支付註銷手續費");

  add2(s.credits, a, String(e.batchId), -e.amountKg);
  if (fee > 0n) { add1(s.cash, a, -fee); s.treasuryCash += fee; }
  b.retiredKg += e.amountKg;
  const certId = s.nextCertId++;
  s.certificates.set(String(certId), {
    id: certId, batchId: e.batchId, account: e.account, amountKg: e.amountKg, beneficiary: e.beneficiary,
    beneficiaryHash: e.beneficiaryHash, purpose: e.purpose, memo: e.memo, retiredAt: e.at, country,
    scheme: s.projects.get(String(b.projectId))?.scheme ?? j.scheme, fee, atSeq: e.seq,
    documentHash: null, officialRef: "", officialAt: 0n,
  });
}

/// 狀態 → 餘額樹的輸入。鎖住的東西也算使用者的；手續費算在國庫名下。
export function balancesOf(s: State): { account: Address; assets: { batchId: bigint; kg: bigint }[]; cash: bigint }[] {
  const accounts = new Set<string>([...s.credits.keys(), ...s.cash.keys(), ...s.lockedCredits.keys(), ...s.lockedCash.keys()]);
  const treasury = lower(s.policy.treasury);
  if (s.treasuryCash > 0n) accounts.add(treasury);
  const out = [];
  for (const a of [...accounts].sort()) {
    const assets = new Map<string, bigint>();
    for (const [batch, kg] of s.credits.get(a) ?? []) if (kg > 0n) assets.set(batch, (assets.get(batch) ?? 0n) + kg);
    for (const [batch, kg] of s.lockedCredits.get(a) ?? []) if (kg > 0n) assets.set(batch, (assets.get(batch) ?? 0n) + kg);
    let cash = (s.cash.get(a) ?? 0n) + (s.lockedCash.get(a) ?? 0n);
    if (a === treasury) cash += s.treasuryCash;
    if (assets.size === 0 && cash === 0n) continue;
    out.push({
      account: a as Address,
      assets: [...assets.entries()].map(([batchId, kg]) => ({ batchId: BigInt(batchId), kg })).sort((x, y) => (x.batchId < y.batchId ? -1 : 1)),
      cash,
    });
  }
  return out;
}
