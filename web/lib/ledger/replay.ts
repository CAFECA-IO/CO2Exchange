import { recoverAddress, type Address, type Hex, type PublicClient } from "viem";
import { roleFor, type Authorities } from "./authorities.ts";
import { emptyKeyBook, verifyAuthoritySignatures, verifyUserSignature, type KeyBook, type SigCheck } from "./signatures.ts";
import { apply, genesis, RULES_VERSION, type State } from "./engine.ts";
import { chainHash, GENESIS, logTree, signerOf, type Event } from "./events.ts";
import { ZERO } from "./merkle.ts";
import { anchorOf, rootsOf, type Roots } from "./trees.ts";
import { digestOf, type Domains } from "./typed.ts";

/// 重播：帳本 → 驗簽 → 引擎 → 每一期的四個 root → anchor 鏈。
///
/// 要驗的不變式：`replay(log) 得出的第 k 期 anchor == 鏈上第 k 期的 anchor`。
/// 左邊任何人拿到 log 都能自己算；右邊在鏈上。對不上，就是交易所提交的承諾不是從它自己的紀錄算出來的。

export type { SigCheck } from "./signatures.ts";

/// 收單區塊的容許誤差：一筆事件的 `atBlock` 不得早於上一期 `upToBlock` 減這個數。
/// 沒有這條，營運方可以把一張單的收單區塊往前填到某把金鑰被撤銷之前。容許一點點是因為
/// 收單與提交是兩個行程，同一時間讀到的最新區塊可能差一兩塊。
export const AT_BLOCK_MARGIN = 20n;

/// 收單當下的即時驗證（ERC-1271 用**現在**的狀態，不需要 archive）。**只給收單用**——
/// 查核時不能用它：過了 128 個區塊，Boltchain 的公開節點就答不出當時的狀態。
export function liveErc1271(client: PublicClient) {
  const ERC1271 = [{
    type: "function", name: "isValidSignature", stateMutability: "view",
    inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }],
    outputs: [{ name: "", type: "bytes4" }],
  }] as const;
  return async ({ signer, digest, signature }: { signer: Address; digest: Hex; signature: Hex }): Promise<SigCheck> => {
    const code = await client.getCode({ address: signer }).catch(() => undefined);
    if (!code || code === "0x") {
      try {
        const who = await recoverAddress({ hash: digest, signature });
        return who.toLowerCase() === signer.toLowerCase() ? { ok: true } : { ok: false, reason: "簽章者不符" };
      } catch { return { ok: false, reason: "簽章格式錯誤" }; }
    }
    try {
      const magic = await client.readContract({ address: signer, abi: ERC1271, functionName: "isValidSignature", args: [digest, signature] });
      return magic.toLowerCase() === "0x1626ba7e" ? { ok: true } : { ok: false, reason: "帳戶合約不認這個簽章" };
    } catch (e) {
      return { ok: false, reason: `帳戶合約驗證失敗：${String((e as Error).message).slice(0, 80)}` };
    }
  };
}

/// 逐筆驗簽，完全離線（不讀任何合約狀態）：授權事件 k-of-n ecrecover；使用者事件 ecrecover 或 CAFECA WebAuthn。
/// 另外檢查收單區塊落在所屬那一期的範圍內（見 AT_BLOCK_MARGIN）。
export async function verifySignatures(
  events: Event[],
  opts: { domains: Domains; authorities: Authorities; keys?: KeyBook; boundaries?: EpochBoundary[]; concurrency?: number },
): Promise<Map<string, SigCheck>> {
  const out = new Map<string, SigCheck>();
  const keys = opts.keys ?? emptyKeyBook();
  const bounds = [...(opts.boundaries ?? [])].sort((a, b) => (a.epoch < b.epoch ? -1 : 1));
  const windowOf = (seq: bigint): { lo: bigint | null; hi: bigint | null } => {
    let prevUpTo: bigint | null = null;
    for (const b of bounds) {
      if (seq <= b.lastSeq) return { lo: prevUpTo === null ? null : prevUpTo - AT_BLOCK_MARGIN, hi: b.upToBlock };
      prevUpTo = b.upToBlock;
    }
    return { lo: prevUpTo === null ? null : prevUpTo - AT_BLOCK_MARGIN, hi: null };
  };
  const work = events.filter((e) => digestOf(opts.domains, e) !== null);
  const n = opts.concurrency ?? 16;
  for (let i = 0; i < work.length; i += n) {
    await Promise.all(work.slice(i, i + n).map(async (e) => {
      const w = windowOf(e.seq);
      if ((w.lo !== null && e.atBlock < w.lo) || (w.hi !== null && e.atBlock > w.hi)) {
        out.set(String(e.seq), { ok: false, reason: `收單區塊 ${e.atBlock} 不在所屬那一期的範圍內` });
        return;
      }
      const signer = signerOf(e)!;
      const digest = digestOf(opts.domains, e)!;
      const signature = (e as { signature: Hex }).signature;
      const role = roleFor(e);
      out.set(String(e.seq), role
        ? await verifyAuthoritySignatures({ role, signer, digest, signature, atBlock: e.atBlock }, opts.authorities)
        : await verifyUserSignature({ account: signer, digest, signature, atBlock: e.atBlock }, keys));
    }));
  }
  return out;
}

export type EpochBoundary = { epoch: bigint; lastSeq: bigint; upToBlock: bigint };
/// 鏈上承諾的欄位（快速模式沿用）。和 chain.ts 的 OnchainCommitment 相同，這裡另寫一份免得循環 import
type ChainEpoch = { anchor: Hex; logRoot: Hex; balanceRoot: Hex; registryRoot: Hex; identityRoot: Hex; totalKg: bigint; totalCash: bigint; totalsHash: Hex };
export type EpochResult = EpochBoundary & {
  firstSeq: bigint; logRoot: Hex; anchor: Hex; prev: Hex; rulesVersion: number;
  roots: Omit<Roots, "balanceTree" | "registry" | "identity">;
};

function sortAndCheck(events: Event[]): Event[] {
  const sorted = [...events].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  sorted.forEach((e, i) => {
    if (e.seq !== BigInt(i + 1)) throw new Error(`帳本缺號：第 ${i + 1} 筆的序號是 ${e.seq}`);
  });
  return sorted;
}

/// 從頭重播到每一個期別邊界，得出每一期的承諾值。
///
/// `boundaries` 通常是鏈上已經提交的那幾期（epoch、lastSeq、upToBlock 都在鏈上）；
/// 再加一期「現在」就是下一次要提交的內容。
///
/// ## 快速模式（`trust`，只給每小時的承諾工具用）
///
/// 已經上鏈、而且提交之前已經完整查核過的那幾期，不必每小時重做一遍：
///   · 那幾期的事件**逐期重算 logRoot**，和鏈上那一期的 logRoot 比對——事件被改過一個位元就對不上；
///     對得上才沿用鏈上的 anchor 與四個 root（`boundaries` 裡帶的鏈上欄位），不重建餘額樹與登錄簿樹。
///   · 簽章只重驗 `verifyFromSeq` 之後的事件（之前的在提交那一期時驗過，logRoot 證明它們沒被換過）。
///   · 狀態照樣從創世套用每一筆事件（引擎本身很便宜），`beforeEpoch` 那一期與之後照常算 root 與 anchor——
///     所以最後一期已上鏈的承諾仍然是完整重算、和鏈上比對的。
/// 帳本一年有八千多期，每一期都重建一次樹，每小時的提交就要跑好幾分鐘；快速模式只重建最後兩期。
/// **查核（ledger:verify）不用快速模式**：查核者不相信之前任何一次的結果。
export async function replay(
  events: Event[],
  opts: {
    domains: Domains; authorities: Authorities; keys?: KeyBook;
    boundaries: (EpochBoundary & Partial<ChainEpoch>)[];
    trust?: { beforeEpoch: bigint; verifyFromSeq: bigint };
  },
): Promise<{ state: State; epochs: EpochResult[]; sig: Map<string, SigCheck>; runningHash: Hex; last: Roots | null }> {
  const sorted = sortAndCheck(events);
  const trust = opts.trust;
  const sig = await verifySignatures(trust ? sorted.filter((e) => e.seq >= trust.verifyFromSeq) : sorted, opts);
  const state = genesis();
  const ctx = { sigOk: (seq: bigint) => (trust && seq < trust.verifyFromSeq) || sig.get(String(seq))?.ok === true };
  const epochs: EpochResult[] = [];
  let prev: Hex = ZERO;
  let from = 0n;
  let last: Roots | null = null;
  const bounds = [...opts.boundaries].sort((a, b) => (a.epoch < b.epoch ? -1 : 1));
  for (const b of bounds) {
    if (b.lastSeq < from) throw new Error(`第 ${b.epoch} 期的 lastSeq ${b.lastSeq} 倒退`);
    if (b.lastSeq > BigInt(sorted.length)) throw new Error(`第 ${b.epoch} 期宣稱到第 ${b.lastSeq} 筆，但帳本只有 ${sorted.length} 筆`);
    const slice = sorted.slice(Number(from), Number(b.lastSeq));
    apply(state, slice, ctx);
    if (trust && b.epoch < trust.beforeEpoch && b.anchor && b.logRoot && b.balanceRoot) {
      const logRoot = logTree(slice).root;
      // 對不上就給一個不可能等於鏈上的 anchor，呼叫端的「逐期比對」自然會擋下來
      const anchor = logRoot === b.logRoot ? b.anchor : (`0x${"ee".repeat(32)}` as Hex);
      epochs.push({
        epoch: b.epoch, lastSeq: b.lastSeq, upToBlock: b.upToBlock, firstSeq: from + 1n, logRoot, anchor, prev, rulesVersion: RULES_VERSION,
        roots: { balanceRoot: b.balanceRoot, registryRoot: b.registryRoot!, identityRoot: b.identityRoot!, totalKg: b.totalKg!, totalCash: b.totalCash!, totalsHash: b.totalsHash! },
      });
      prev = anchor;
      from = b.lastSeq;
      continue;
    }
    const roots = rootsOf(state, b.epoch);
    last = roots;
    const logRoot = logTree(slice).root;
    const anchor = anchorOf({
      prev, epoch: b.epoch, logRoot, balanceRoot: roots.balanceRoot, registryRoot: roots.registryRoot, identityRoot: roots.identityRoot,
      totalKg: roots.totalKg, totalCash: roots.totalCash, totalsHash: roots.totalsHash, upToBlock: b.upToBlock, lastSeq: b.lastSeq, rulesVersion: RULES_VERSION,
    });
    const { balanceTree: _bt, registry: _r, identity: _i, ...plain } = roots;
    void _bt; void _r; void _i;
    epochs.push({ ...b, firstSeq: from + 1n, logRoot, anchor, prev, rulesVersion: RULES_VERSION, roots: plain });
    prev = anchor;
    from = b.lastSeq;
  }
  // 最後一個邊界之後的事件也跑進狀態裡（畫面要看到最新的），但不屬於任何一期
  if (from < BigInt(sorted.length)) apply(state, sorted.slice(Number(from)), ctx);
  let running = GENESIS;
  for (const e of sorted) running = chainHash(running, e);
  return { state, epochs, sig, runningHash: running, last };
}
