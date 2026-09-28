import type { Address, Hex } from "viem";
import { eventHash, logTree, type Event } from "./events.ts";
import type { OnchainCommitment } from "./chain.ts";
import { snapshotAt, toJson, COMMITTED_EVENT, SCHEMES, type Snapshot } from "./proofs.ts";
import { TAG } from "./trees.ts";

/// 每一期的公開檔（設計 v4 §六「分層公開」的公開層）。
///
/// 內容：
///   · manifest：這一期的承諾（鏈上交易、log、各個 root 與總額）
///   · leaves：這一期**每一筆**事件的雜湊（依序號）——任何人拿它就能重算 logRoot。
///     雜湊不洩漏內容；私密事件（委託單、身分、存提）只公開到這一層
///   · publicEvents：登錄簿層的事件**全文**＋對 logRoot 的包含證據（轄區、政策、費率、專案、核發、註銷、憑證、對帳報告、批次凍結）
///   · registry：登錄簿現在的狀態（轄區、專案、批次、憑證、對帳報告、政策、費率）與每一片葉子的內容雜湊——可以重算 registryRoot
///   · totals：逐批次總量表（totalsHash 的原文）
///
/// 身分只公開 identityRoot；委託單與成交明細在監理鏡像（完整帳本）裡。

/// 登錄簿層：這些事件全文公開。其他種類（place、cancel、identity、存提、提領請求、金鑰鏡像、帳戶凍結）只公開雜湊
export function isPublicEvent(e: Event): boolean {
  switch (e.kind) {
    case "jurisdiction": case "policy": case "fees": case "project": case "importProject": case "projectStatus":
    case "issue": case "retire": case "certDocument": case "certOfficial": case "reserveReport": case "reserveAttest":
      return true;
    case "freeze":
      return e.target === 1; // 批次凍結公開；帳戶凍結是個人資料
    default:
      return false;
  }
}

export function publicEpoch(o: { chainId: number; ledger: Address; events: Event[]; commitments: OnchainCommitment[]; epochIndex: number; snap?: Snapshot }) {
  const c = o.commitments[o.epochIndex];
  if (!c) throw new Error(`沒有第 ${o.epochIndex + 1} 期`);
  const from = o.epochIndex === 0 ? 1n : o.commitments[o.epochIndex - 1].lastSeq + 1n;
  const slice = o.events.filter((e) => e.seq >= from && e.seq <= c.lastSeq);
  const tree = logTree(slice);
  if (tree.root !== c.logRoot) throw new Error(`第 ${c.epoch} 期的 logRoot 重算為 ${tree.root}，鏈上是 ${c.logRoot}`);
  const snap = o.snap ?? snapshotAt(o.events, c);
  const s = snap.state;

  return toJson({
    version: 1, chainId: o.chainId, schemes: SCHEMES,
    manifest: {
      contract: o.ledger, event: COMMITTED_EVENT, txHash: c.txHash, logIndex: c.logIndex, blockNumber: c.block,
      epoch: c.epoch, anchor: c.anchor, prev: c.prev, firstSeq: from, lastSeq: c.lastSeq, upToBlock: c.upToBlock, rulesVersion: c.rulesVersion,
      logRoot: c.logRoot, balanceRoot: c.balanceRoot, registryRoot: c.registryRoot, identityRoot: c.identityRoot,
      totalKg: c.totalKg, totalCash: c.totalCash, totalsHash: c.totalsHash,
    },
    leaves: slice.map((e) => ({ seq: e.seq, kind: e.kind, hash: eventHash(e), public: isPublicEvent(e) })),
    publicEvents: slice.filter(isPublicEvent).map((e) => ({ seq: e.seq, kind: e.kind, hash: eventHash(e), event: e, proof: tree.proofOf(e.seq) })),
    registry: {
      root: snap.roots.registryRoot,
      leaves: snap.roots.registry.entries.map((x) => ({ tag: Object.entries(TAG).find(([, v]) => v === x.tag)?.[0] ?? String(x.tag), id: x.id, contentHash: x.content })),
      jurisdictions: [...s.jurisdictions.values()],
      projects: [...s.projects.values()],
      batches: [...s.batches.values()],
      certificates: [...s.certificates.values()],
      reports: [...s.reports.values()],
      policy: s.policy,
      fees: { tradeBps: s.fees.tradeBps, retireFeePerTonne: s.fees.retireFeePerTonne, byCountry: Object.fromEntries(s.fees.byCountry) },
    },
    totals: { byBatch: snap.roots.balanceTree?.totalsByBatch ?? [], totalCash: snap.roots.totalCash, totalsHash: snap.roots.totalsHash },
    identity: { root: snap.roots.identityRoot, accounts: s.identities.size, note: "身分只公開 root：每位使用者從自己的證明檔驗自己那一片" },
  }) as Record<string, unknown>;
}

export const epochIndexOf = (commitments: OnchainCommitment[], epoch: bigint) => commitments.findIndex((c) => c.epoch === epoch);
export type PublicEpoch = ReturnType<typeof publicEpoch>;
export type { Hex };
