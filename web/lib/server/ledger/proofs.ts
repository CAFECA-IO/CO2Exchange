import "server-only";
import type { Address } from "viem";
import { PROOF_ABI, readCommitments, type OnchainCommitment } from "@/lib/ledger/chain";
import { snapshotAt, userProofFile, type Snapshot } from "@/lib/ledger/proofs";
import { epochIndexOf, publicEpoch } from "@/lib/ledger/publish";
import { ApiError } from "../api";
import { deployment, publicClient } from "../chain";
import { ledgerView } from "./view";

/// 證據的伺服器端（設計 v4 第 6 期）：使用者的證明檔、出金確認要帶的證據（見 fiat.ts）。
///
/// 證據一律對**鏈上最新一期**出（合約的 settleWithdrawal 只收最新一期的證據）。快照依期別快取：
/// 一期一小時，每一期只重播一次、建一次樹。快照建出來之後先和鏈上的 root 比對，對不上就不給——
/// 給出去的證明檔在鏈上驗不過，比沒有證明檔更糟。

/// 已上鏈的各期。每次先問合約現在是第幾期（一次 eth_call），期數變了才重讀事件——
/// 用時間當快取的話，剛提交的那一期要等快取過期才看得到，使用者會以為承諾沒上鏈。
let commitCache: { key: string; epoch: bigint; value: OnchainCommitment[] } | null = null;
export async function commitments(): Promise<OnchainCommitment[]> {
  const d = deployment();
  const key = `${d.ledger}|${d.deployedAt ?? ""}`;
  const epoch = await publicClient.readContract({ address: d.ledger!, abi: PROOF_ABI, functionName: "epoch" });
  if (commitCache && commitCache.key === key && commitCache.epoch === epoch) return commitCache.value;
  const value = await readCommitments(publicClient, d.ledger!, { fromBlock: BigInt(d.deployedAtBlock ?? 0) });
  commitCache = { key, epoch, value };
  return value;
}

let snapCache: { key: string; snap: Snapshot } | null = null;
export async function latestSnapshot(): Promise<Snapshot | null> {
  const cs = await commitments();
  const c = cs.at(-1);
  if (!c) return null;
  const d = deployment();
  const key = `${d.ledger}|${d.deployedAt ?? ""}|${c.epoch}`;
  if (snapCache?.key === key) return snapCache.snap;
  const snap = snapshotAt(ledgerView().events, c);
  snapCache = { key, snap };
  return snap;
}

/// 使用者的證明檔（Boltchain Issue #1 的格式）
export async function proofFileOf(account: Address) {
  const snap = await latestSnapshot();
  if (!snap) throw new ApiError("NOT_FOUND", "帳本還沒有任何一期承諾上鏈，沒有證據可以給");
  const d = deployment();
  return userProofFile({
    chainId: d.chainId, ledger: d.ledger!, settlementToken: d.settlementToken, account,
    commitments: await commitments(), events: ledgerView().events, snap,
  });
}

// ── 公開檔（每一期） ──

/// 已上鏈的各期（公開：任何人都能從鏈上讀到同樣的東西）
export async function publicEpochList() {
  const cs = await commitments();
  return cs.map((c, i) => ({
    epoch: c.epoch, anchor: c.anchor, txHash: c.txHash, blockNumber: c.block,
    firstSeq: i === 0 ? 1n : cs[i - 1].lastSeq + 1n, lastSeq: c.lastSeq, totalKg: c.totalKg, totalCash: c.totalCash,
  }));
}

const pubCache = new Map<string, Record<string, unknown>>();
/// 一期的公開檔。已上鏈的期別不會再變，快取住（鍵含部署，換部署就不會拿到舊的）
export async function publicEpochFile(epoch: bigint) {
  const d = deployment();
  const key = `${d.ledger}|${d.deployedAt ?? ""}|${epoch}`;
  const hit = pubCache.get(key);
  if (hit) return hit;
  const cs = await commitments();
  const i = epochIndexOf(cs, epoch);
  if (i < 0) throw new ApiError("NOT_FOUND", `鏈上沒有第 ${epoch} 期`);
  const f = publicEpoch({ chainId: d.chainId, ledger: d.ledger!, events: ledgerView().events, commitments: cs, epochIndex: i });
  pubCache.set(key, f);
  return f;
}
