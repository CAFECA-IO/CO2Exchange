import { keccak256, type Address, type Hex } from "viem";
import { apply, genesis, type State } from "./engine.ts";
import { encodeEvent, eventHash, logTree, type Event } from "./events.ts";
import type { OnchainCommitment } from "./chain.ts";
import { rootsOf, TAG, type Roots } from "./trees.ts";

/// 證據（設計 v4 第 6 期；規則第 4 版）：使用者的證明檔、營運 Safe 確認出金時帳本合約要的參數。
///
/// ## 證明檔的格式
///
/// 照 Boltchain Issue #1 提議的格式（`version`、`chainId`、`anchor`、`scheme`、葉子、`siblings`、`path`），
/// 讓 Explorer 或任何第三方**不必懂交易所的業務邏輯**就能驗：
///
///   · 每一項證據都帶自己的 `anchor`——哪一筆鏈上交易的哪一個 log、`Committed` 事件裡的哪個欄位。
///   · 每一項都給出葉子的**原像**（ABI 型別與值、或整段編碼），驗證者自己算雜湊，不必相信檔案裡寫的雜湊。
///   · `scheme` 從下面三種挑一種，規則寫死、公開（`docs/proof-schemes.md` 也寫了一份）。
///
/// 證明檔**不含任何別人的資料**：兄弟節點只是雜湊與（總額樹的）加總。
///
/// 這個檔案不依賴 Next：驗證 CLI（`scripts/verify-proof.mjs`）與網站共用。

export const PROOF_FILE_VERSION = 1;

/// 三種雜湊規則。改任何一個字元都是新的名字。
export const SCHEMES = {
  /// 事件、登錄簿、身分：leaf = keccak256(abi.encode(bytes1 0x00, bytes32 contentHash))；
  /// node = keccak256(abi.encode(bytes1 0x01, bytes32 left, bytes32 right))；落單的節點往上帶；
  /// path 的第 i 位是 1 = 第 i 個兄弟在左邊。
  inclusion: "co2x-keccak-abi-prefixed-v1",
  /// 託管（餘額總額樹）：leaf = keccak256(abi.encodePacked(0x00, account, uint64 epoch, assetsRoot, uint256 kg, uint256 cash, uint256 requested, uint256 settled))；
  /// node = keccak256(abi.encodePacked(0x01, l.hash, l.kg, l.cash, r.hash, r.kg, r.cash))，總額相加；root 的兩個總額要等於承諾的 totalKg / totalCash。
  sum: "co2x-merkle-sum-v2",
  /// 帳戶的逐批次小樹：leaf = keccak256(abi.encodePacked(0x00, uint256 batchId, uint256 kg))；node = keccak256(abi.encodePacked(0x01, l, r))。
  asset: "co2x-asset-packed-v1",
} as const;

/// `Committed` 事件的簽章。anchor 指向它，field 指向 commitment 裡的欄位。
export const COMMITTED_EVENT =
  "Committed(uint64,bytes32,(bytes32,uint64,bytes32,bytes32,bytes32,bytes32,uint256,uint256,bytes32,uint64,uint64,uint16))";

export type Anchor = { contract: Address; event: string; txHash: Hex; logIndex: number; blockNumber: string; epoch: string; field: string; root: Hex };

const anchorOf = (ledger: Address, c: OnchainCommitment, field: "balanceRoot" | "registryRoot" | "identityRoot" | "logRoot"): Anchor => ({
  contract: ledger, event: COMMITTED_EVENT, txHash: c.txHash, logIndex: c.logIndex, blockNumber: c.block.toString(),
  epoch: c.epoch.toString(), field: `commitment.${field}`, root: c[field],
});

// ── 某一期的狀態快照 ──

export type Snapshot = { commitment: OnchainCommitment; state: State; roots: Roots };

/// 重播到第 `c.lastSeq` 筆，建出那一期的四棵樹，並**確認和鏈上的承諾一致**——
/// 對不上的快照拿去出證據，使用者會拿著「正確」的證明檔卻在鏈上驗不過。
export function snapshotAt(events: Event[], c: OnchainCommitment): Snapshot {
  const upTo = events.filter((e) => e.seq <= c.lastSeq);
  if (BigInt(upTo.length) !== c.lastSeq) throw new Error(`帳本只有 ${upTo.length} 筆，第 ${c.epoch} 期宣稱到第 ${c.lastSeq} 筆`);
  const state = apply(genesis(), upTo, { sigOk: () => true });
  const roots = rootsOf(state, c.epoch);
  for (const k of ["balanceRoot", "registryRoot", "identityRoot"] as const) {
    if (roots[k] !== c[k]) throw new Error(`第 ${c.epoch} 期的 ${k} 重算為 ${roots[k]}，鏈上是 ${c[k]}`);
  }
  if (roots.totalKg !== c.totalKg || roots.totalCash !== c.totalCash) throw new Error(`第 ${c.epoch} 期的總額與鏈上不符`);
  return { commitment: c, state, roots };
}

/// 每一期的事件區間（第幾筆到第幾筆），給事件包含證據用
export function epochOfSeq(commitments: OnchainCommitment[], seq: bigint): { c: OnchainCommitment; from: bigint } | null {
  let from = 1n;
  for (const c of commitments) {
    if (seq <= c.lastSeq && seq >= from) return { c, from };
    from = c.lastSeq + 1n;
  }
  return null;
}

// ── 帳本合約要的參數 ──

export type BalanceProofArgs = {
  proofEpoch: bigint; assetsRoot: Hex; leafKg: bigint; leafCash: bigint; leafRequested: bigint; leafSettled: bigint;
  siblings: { hash: Hex; kg: bigint; cash: bigint }[]; path: bigint;
};

export function balanceProofArgs(snap: Snapshot, account: Address): BalanceProofArgs | null {
  const t = snap.roots.balanceTree;
  if (!t) return null;
  let p;
  try { p = t.proofOf(account); } catch { return null; }
  return {
    proofEpoch: snap.commitment.epoch, assetsRoot: p.assetsRoot, leafKg: p.leafKg, leafCash: p.leafCash,
    leafRequested: p.leafRequested ?? 0n, leafSettled: p.leafSettled ?? 0n, siblings: p.siblings, path: p.path,
  };
}

export function creditProofArgs(snap: Snapshot, account: Address, batchId: bigint) {
  const t = snap.roots.balanceTree!;
  const ap = t.assetProofOf(account, batchId);
  const rp = snap.roots.registry.proofOf(TAG.batch, batchId);
  const b = snap.state.batches.get(String(batchId))!;
  return {
    batchKg: ap.kg, assetSiblings: ap.siblings, assetPath: ap.path,
    batch: {
      id: b.id, projectId: b.projectId, monitoringStart: b.monitoringStart, monitoringEnd: b.monitoringEnd, vintageYear: b.vintageYear,
      serialHash: b.serialHash, reportHash: b.reportHash, verifier: b.verifier, issuedAt: b.issuedAt, issuedKg: b.issuedKg, retiredKg: b.retiredKg, frozen: b.frozen,
    },
    registrySiblings: rp.siblings, registryPath: rp.path,
  };
}

// ── 使用者的證明檔 ──

const IDENTITY_TYPES = ["address", "uint8", "uint64", "bytes2", "bytes32", "bool"];
const BATCH_TYPES = ["uint8", "uint256", "uint256", "uint64", "uint64", "uint16", "bytes32", "bytes32", "address", "uint64", "uint256", "uint256", "bool"];

/// 使用者自己的證明檔：他在最新一期的持有（託管證據）、每一批額度、身分，以及他自己的事件的包含證據。
///
/// `commitments` 是鏈上已提交的各期（依期別排好）；`snap` 是最新一期的快照。
export function userProofFile(o: {
  chainId: number; ledger: Address; settlementToken: Address; account: Address;
  commitments: OnchainCommitment[]; events: Event[]; snap: Snapshot; generatedAt?: string; maxEvents?: number;
}) {
  const { snap, account } = o;
  const low = account.toLowerCase();
  const c = snap.commitment;
  const proofs: Record<string, unknown>[] = [];

  // 1. 託管證據：餘額總額樹的葉子
  const bp = balanceProofArgs(snap, account);
  if (bp) {
    proofs.push({
      type: "custody", scheme: SCHEMES.sum, anchor: anchorOf(o.ledger, c, "balanceRoot"),
      leaf: { account, epoch: c.epoch, assetsRoot: bp.assetsRoot, kg: bp.leafKg, cash: bp.leafCash, requested: bp.leafRequested, settled: bp.leafSettled },
      siblings: bp.siblings, path: bp.path,
      rootTotals: { kg: c.totalKg, cash: c.totalCash },
      custody: { token: o.settlementToken, holder: o.ledger, note: "root 的 cash 總額 ≤ 帳本合約持有的記帳 TWD（balanceOf(holder)）＝營運方宣稱的信託專戶餘額" },
      meaning: "帳本在這一期欠這個帳戶：碳權 kg 公斤、新台幣 cash（最小單位，含掛單鎖定與待出金）；requested／settled 是出金的請求累計與已出金累計",
    });
    // 2. 每一批額度：帳戶的小樹 ＋ 登錄簿裡的那一批
    const assets = [...(snap.state.credits.get(low) ?? new Map()).keys(), ...(snap.state.lockedCredits.get(low) ?? new Map()).keys()];
    for (const id of [...new Set(assets)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))) {
      const cp = creditProofArgs(snap, account, BigInt(id));
      const b = cp.batch;
      proofs.push({
        type: "credit", batchId: id,
        holding: { scheme: SCHEMES.asset, leaf: { batchId: BigInt(id), kg: cp.batchKg }, siblings: cp.assetSiblings, path: cp.assetPath, root: bp.assetsRoot, rootIs: "custody.leaf.assetsRoot" },
        registry: {
          scheme: SCHEMES.inclusion, anchor: anchorOf(o.ledger, c, "registryRoot"),
          content: { types: BATCH_TYPES, values: [TAG.batch, b.id, b.projectId, b.monitoringStart, b.monitoringEnd, b.vintageYear, b.serialHash, b.reportHash, b.verifier, b.issuedAt, b.issuedKg, b.retiredKg, b.frozen] },
          siblings: cp.registrySiblings, path: cp.registryPath,
        },
        meaning: `帳戶持有批次 #${id} 的 ${cp.batchKg} 公斤；這一批在同一期的登錄簿裡。碳權提不出平台，這兩段是請求權的審計證據`,
      });
    }
  }

  // 3. 身分：只有雜湊，沒有原文
  const id = snap.state.identities.get(low);
  if (id) {
    const ip = snap.roots.identity.proofOf(account);
    proofs.push({
      type: "identity", scheme: SCHEMES.inclusion, anchor: anchorOf(o.ledger, c, "identityRoot"),
      content: { types: IDENTITY_TYPES, values: [id.account, id.tier, id.expiry, countryHex(id.jurisdiction), id.identityHash, id.frozen] },
      siblings: ip.siblings, path: ip.path,
      meaning: "身分等級、效期、轄區、凍結狀態與身分雜湊（姓名、證號等原文不在帳本裡）",
    });
  }

  // 4. 他自己的事件（最新的 maxEvents 筆）：每一筆對所屬那一期的 logRoot
  const mine = o.events.filter((e) => involves(e, low)).slice(-(o.maxEvents ?? 200));
  const trees = new Map<string, ReturnType<typeof logTree>>();
  for (const e of mine) {
    const at = epochOfSeq(o.commitments, e.seq);
    if (!at) continue; // 還沒提交的事件：收據是它目前的憑據
    const key = String(at.c.epoch);
    if (!trees.has(key)) trees.set(key, logTree(o.events.filter((x) => x.seq >= at.from && x.seq <= at.c.lastSeq)));
    const p = trees.get(key)!.proofOf(e.seq);
    const encoded = encodeEvent(e);
    proofs.push({
      type: "event", scheme: SCHEMES.inclusion, anchor: anchorOf(o.ledger, at.c, "logRoot"),
      seq: e.seq, kind: e.kind, contentHash: keccak256(encoded), encoded, event: toJson(e),
      siblings: p.siblings, path: p.path,
      meaning: "這一筆事件原封不動地在那一期的事件樹裡（contentHash = keccak256(encoded)）",
    });
  }

  return toJson({
    version: PROOF_FILE_VERSION, chainId: o.chainId, generator: "CO2Exchange ledger v2 (rules 4)",
    generatedAt: o.generatedAt ?? new Date().toISOString(),
    account, latestEpoch: c.epoch, schemes: SCHEMES,
    proofs,
    note: "兄弟節點只是雜湊（與總額樹的加總），不含任何其他帳戶的資料。驗證方式見 scripts/verify-proof.mjs",
  });
}

function involves(e: Event, low: string): boolean {
  if ("account" in e && typeof e.account === "string" && e.account.toLowerCase() === low) return true;
  return false;
}

const countryHex = (c: string): Hex => {
  const s = (c || "\u0000\u0000").padEnd(2, "\u0000").slice(0, 2);
  return `0x${s.charCodeAt(0).toString(16).padStart(2, "0")}${s.charCodeAt(1).toString(16).padStart(2, "0")}`;
};

/// bigint → 十進位字串（JSON 沒有 bigint）
export function toJson<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

export { eventHash };
