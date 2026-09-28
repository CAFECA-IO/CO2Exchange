import { recoverAddress, type Address, type Hex, type PublicClient } from "viem";
import { isAuthorized, roleFor, type Authorities } from "./authorities.ts";
import { apply, genesis, RULES_VERSION, type State } from "./engine.ts";
import { chainHash, GENESIS, logTree, signerOf, type Event } from "./events.ts";
import { ZERO } from "./merkle.ts";
import { anchorOf, rootsOf, type Roots } from "./trees.ts";
import { digestOf, type Domains } from "./typed.ts";

/// 重播：帳本 → 驗簽 → 引擎 → 每一期的四個 root → anchor 鏈。
///
/// 要驗的不變式：`replay(log) 得出的第 k 期 anchor == 鏈上第 k 期的 anchor`。
/// 左邊任何人拿到 log 都能自己算；右邊在鏈上。對不上，就是交易所提交的承諾不是從它自己的紀錄算出來的。

export type SigCheck = { ok: boolean; reason?: string; trusted?: boolean };
/// 驗一個簽章。`atBlock` 是收單時的區塊高度：CAFECA 帳戶（ERC-1271）與 Safe 的簽章要在那個高度驗。
export type SigVerifier = (a: { signer: Address; digest: Hex; signature: Hex; atBlock: bigint }) => Promise<SigCheck>;

/// 只驗 EOA（ecrecover）。測試與沒有節點時用。
export const ecdsaVerifier: SigVerifier = async ({ signer, digest, signature }) => {
  try {
    const who = await recoverAddress({ hash: digest, signature });
    return who.toLowerCase() === signer.toLowerCase() ? { ok: true } : { ok: false, reason: "簽章者不符" };
  } catch { return { ok: false, reason: "簽章格式錯誤" }; }
};

const ERC1271 = [{
  type: "function", name: "isValidSignature", stateMutability: "view",
  inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }],
  outputs: [{ name: "", type: "bytes4" }],
}] as const;

/// 完整驗證：簽章者在 `atBlock` 沒有合約碼 → ecrecover；有合約碼 → 在那個高度呼叫 `isValidSignature`。
///
/// 查舊區塊的狀態需要 archive 節點。`trustOnMissingState` 為 true 時，節點答不出舊狀態的那幾筆
/// 會被標成「信任收單時的驗證」（trusted），重播報告會列出來——查核者自己決定能不能接受。
export function onchainVerifier(client: PublicClient, opts: { trustOnMissingState?: boolean } = {}): SigVerifier {
  return async ({ signer, digest, signature, atBlock }) => {
    let code: Hex | undefined;
    try {
      code = await client.getCode({ address: signer, blockNumber: atBlock });
    } catch (e) {
      if (opts.trustOnMissingState) return { ok: true, trusted: true, reason: `節點答不出區塊 ${atBlock} 的狀態：${String((e as Error).message).slice(0, 80)}` };
      return { ok: false, reason: "節點答不出當時的帳戶狀態（需要 archive 節點）" };
    }
    if (!code || code === "0x") return ecdsaVerifier({ signer, digest, signature, atBlock });
    try {
      const magic = await client.readContract({ address: signer, abi: ERC1271, functionName: "isValidSignature", args: [digest, signature], blockNumber: atBlock });
      return magic.toLowerCase() === "0x1626ba7e" ? { ok: true } : { ok: false, reason: "帳戶合約不認這個簽章" };
    } catch (e) {
      if (opts.trustOnMissingState) return { ok: true, trusted: true, reason: `區塊 ${atBlock} 的合約狀態查不到` };
      return { ok: false, reason: `帳戶合約驗證失敗：${String((e as Error).message).slice(0, 80)}` };
    }
  };
}

export async function verifySignatures(
  events: Event[],
  opts: { domains: Domains; authorities: Authorities; verifier: SigVerifier; concurrency?: number },
): Promise<Map<string, SigCheck>> {
  const out = new Map<string, SigCheck>();
  const work = events.filter((e) => digestOf(opts.domains, e) !== null);
  const n = opts.concurrency ?? 16;
  for (let i = 0; i < work.length; i += n) {
    await Promise.all(work.slice(i, i + n).map(async (e) => {
      const signer = signerOf(e)!;
      const role = roleFor(e);
      if (role && !isAuthorized(opts.authorities, role, signer, e.atBlock)) {
        out.set(String(e.seq), { ok: false, reason: `${signer} 在區塊 ${e.atBlock} 沒有 ${role} 授權` });
        return;
      }
      const digest = digestOf(opts.domains, e)!;
      const signature = (e as { signature: Hex }).signature;
      out.set(String(e.seq), await opts.verifier({ signer, digest, signature, atBlock: e.atBlock }));
    }));
  }
  return out;
}

export type EpochBoundary = { epoch: bigint; lastSeq: bigint; upToBlock: bigint };
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
export async function replay(
  events: Event[],
  opts: { domains: Domains; authorities: Authorities; verifier: SigVerifier; boundaries: EpochBoundary[] },
): Promise<{ state: State; epochs: EpochResult[]; sig: Map<string, SigCheck>; runningHash: Hex; last: Roots | null }> {
  const sorted = sortAndCheck(events);
  const sig = await verifySignatures(sorted, opts);
  const state = genesis();
  const ctx = { sigOk: (seq: bigint) => sig.get(String(seq))?.ok === true };
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
