import "server-only";
import { LEDGER_ABI } from "@/lib/ledger/chain";
import { assessLiveness, thresholdsFromEnv, type Liveness } from "@/lib/ledger/liveness";
import { deployment, publicClient } from "../chain";
import { commitments } from "./proofs";
import { ledgerView } from "./view";

/// 承諾排程的現況（判斷規則在 lib/ledger/liveness.ts）。兩次 eth_call ＋ 一次讀區塊；
/// 已上鏈的各期由 commitments() 依期數快取，期數沒變就不重讀事件。
export async function ledgerLiveness(): Promise<Liveness> {
  const d = deployment();
  const [cs, [, , latestEpoch, committedAt], block] = await Promise.all([
    commitments(),
    publicClient.readContract({ address: d.ledger!, abi: LEDGER_ABI, functionName: "solvency" }),
    publicClient.getBlock({ blockTag: "latest" }),
  ]);
  const last = cs.at(-1);
  return assessLiveness({
    wallClock: Math.floor(Date.now() / 1000),
    chainTime: Number(block.timestamp),
    events: ledgerView().events,
    lastEpoch: latestEpoch > 0n ? Number(latestEpoch) : null,
    committedSeq: Number(last?.lastSeq ?? 0n),
    lastCommittedAt: latestEpoch > 0n ? Number(committedAt) : null,
    thresholds: thresholdsFromEnv(),
  });
}
