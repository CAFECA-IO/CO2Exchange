import { keccak256, parseAbi, toBytes, type Address, type Hex, type PublicClient } from "viem";
import { ROLES, type Authorities, type Grant, type Role, type Threshold } from "./authorities.ts";
import type { EpochBoundary } from "./replay.ts";
import { indexedLogs, type IndexOpts } from "./logindex.ts";

/// 從帳本合約讀兩樣東西：授權金鑰清單的歷史、已經提交的承諾。
///
/// 兩樣都從**事件**讀，不從 storage 讀：授權清單要的是「某一把金鑰在哪一段區塊區間有效」，
/// storage 只知道現在；承諾的完整內容也只在事件裡一次給齊。
/// 不依賴 Next、不用路徑別名——查核機構要能單獨跑。

export const LEDGER_ABI = parseAbi([
  "event AuthorityGranted(bytes32 indexed role, address indexed account)",
  "event AuthorityRevoked(bytes32 indexed role, address indexed account)",
  "event ThresholdSet(bytes32 indexed role, uint8 threshold)",
  "function thresholdOf(bytes32 role) view returns (uint8)",
  "struct CommitInput { bytes32 prev; uint64 epoch; bytes32 logRoot; bytes32 balanceRoot; bytes32 registryRoot; bytes32 identityRoot; uint256 totalKg; uint256 totalCash; bytes32 totalsHash; uint64 upToBlock; uint64 lastSeq; uint16 rulesVersion; }",
  "event Committed(uint64 indexed epoch, bytes32 anchor, CommitInput commitment)",
  "event CashDeposited(address indexed account, uint256 amount, bytes32 indexed bankRef)",
  "event CashWithdrawn(address indexed account, uint256 amount, uint64 epoch, bytes32 indexed bankRef)",
  "function head() view returns (bytes32)",
  "function epoch() view returns (uint64)",
  "function commit(CommitInput c) returns (bytes32)",
  "function anchorOf(CommitInput c) pure returns (bytes32)",
  "function cash() view returns (address)",
  "function creditDeposit(address account, uint256 amount, bytes32 bankRef)",
  "function bankRefUsed(bytes32) view returns (bool)",
  "function solvency() view returns (uint256 owedCash, uint256 heldCash, uint64 latestEpoch, uint64 committedAt)",
]);

const ROLE_BY_HASH = new Map<string, Role>(ROLES.map((r) => [keccak256(toBytes(r)).toLowerCase(), r]));

/// `index`：給了就經過磁碟上的增量索引（lib/ledger/logindex.ts），只向鏈上讀新的區塊。查核不要給。
export type Range = { fromBlock: bigint; toBlock?: bigint; index?: Omit<IndexOpts, "name"> };

/// 分段讀事件。Boltchain 的 `eth_getLogs` 單次最多 10,000 個區塊（實測），一次讀全部會直接被拒。
/// 分段大小可用環境變數 `LOGS_CHUNK` 調整。
export const LOGS_CHUNK = BigInt(typeof process !== "undefined" && process.env?.LOGS_CHUNK ? process.env.LOGS_CHUNK : 9_000);

export async function getLogsPaged<T extends { blockNumber: bigint | null }>(
  client: PublicClient, range: Range, fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>, name?: string,
): Promise<T[]> {
  const to = range.toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const paged = async (lo: bigint, hi: bigint) => {
    const out: T[] = [];
    for (let from = lo; from <= hi; from += LOGS_CHUNK) {
      const end = from + LOGS_CHUNK - 1n < hi ? from + LOGS_CHUNK - 1n : hi;
      out.push(...(await fetch(from, end)));
    }
    return out;
  };
  if (!range.index || !name) return paged(range.fromBlock, to);
  return indexedLogs<T>({ ...range.index, name, fromBlock: range.fromBlock, toBlock: to, blockOf: (l) => l.blockNumber ?? 0n, fetch: paged });
}

/// 授權清單的歷史 → 每一把金鑰、每一個角色的有效區間。
/// 同一把金鑰被撤銷後又重新授予，會得到兩段不相連的區間——那正是應該的樣子。
export async function readAuthorities(client: PublicClient, ledger: Address, range: Range): Promise<Authorities> {
  const logs = await getLogsPaged(client, range, (fromBlock, toBlock) => client.getLogs({
    address: ledger,
    events: LEDGER_ABI.filter((x) => x.type === "event" && (x.name === "AuthorityGranted" || x.name === "AuthorityRevoked" || x.name === "ThresholdSet")),
    fromBlock, toBlock,
  }), "authorities");
  logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber! < b.blockNumber! ? -1 : 1));
  const grants: Grant[] = [];
  const thresholds: Threshold[] = [];
  const open = new Map<string, Grant>();
  for (const l of logs) {
    const args = l.args as { role: Hex; account: Address; threshold?: number };
    const role = ROLE_BY_HASH.get(args.role.toLowerCase());
    if (!role) continue; // 不認得的角色（例如將來新增的）不影響現有規則
    if (l.eventName === "ThresholdSet") { thresholds.push({ role, value: Number(args.threshold), from: l.blockNumber! }); continue; }
    const k = `${role}|${args.account.toLowerCase()}`;
    if (l.eventName === "AuthorityGranted" && !open.has(k)) {
      const g: Grant = { role, account: args.account, from: l.blockNumber!, until: null };
      grants.push(g); open.set(k, g);
    } else if (l.eventName === "AuthorityRevoked" && open.has(k)) {
      open.get(k)!.until = l.blockNumber!; open.delete(k);
    }
  }
  return { grants, thresholds };
}

/// 出金確認（營運 Safe 呼叫）與它要的證據結構。葉子帶兩個出金累計（請求、已出金）。
export const PROOF_ABI = parseAbi([
  "struct Node { bytes32 hash; uint256 kg; uint256 cash; }",
  "struct BalanceProof { uint64 proofEpoch; bytes32 assetsRoot; uint256 leafKg; uint256 leafCash; uint256 leafRequested; uint256 leafSettled; Node[] siblings; uint256 path; }",
  "function settleWithdrawal(address account, uint256 amount, bytes32 bankRef, BalanceProof p)",
  "function withdrawnTotal(address) view returns (uint256)",
  "function epoch() view returns (uint64)",
]);

export type OnchainCommitment = EpochBoundary & {
  anchor: Hex; prev: Hex; logRoot: Hex; balanceRoot: Hex; registryRoot: Hex; identityRoot: Hex;
  totalKg: bigint; totalCash: bigint; totalsHash: Hex; rulesVersion: number; block: bigint; txHash: Hex; logIndex: number;
};

export async function readCommitments(client: PublicClient, ledger: Address, range: Range): Promise<OnchainCommitment[]> {
  const logs = await getLogsPaged(client, range, (fromBlock, toBlock) => client.getLogs({
    address: ledger, event: LEDGER_ABI.find((x) => x.type === "event" && x.name === "Committed") as never,
    fromBlock, toBlock,
  }), "committed");
  return (logs as unknown as { args: { anchor: Hex; commitment: Record<string, unknown> }; blockNumber: bigint; transactionHash: Hex; logIndex: number }[]).map((l) => {
    const a = l.args;
    const c = a.commitment as {
      prev: Hex; epoch: bigint; logRoot: Hex; balanceRoot: Hex; registryRoot: Hex; identityRoot: Hex;
      totalKg: bigint; totalCash: bigint; totalsHash: Hex; upToBlock: bigint; lastSeq: bigint; rulesVersion: number;
    };
    return { ...c, anchor: a.anchor, block: l.blockNumber, txHash: l.transactionHash, logIndex: l.logIndex };
  }).sort((x, y) => (x.epoch < y.epoch ? -1 : 1));
}

/// 鏈上的新台幣入金／出金確認——帳本裡的 cashDeposit / cashWithdraw 要一筆一筆對得上它們。
export async function readCashEvents(client: PublicClient, ledger: Address, range: Range) {
  const logs = await getLogsPaged(client, range, (fromBlock, toBlock) => client.getLogs({
    address: ledger,
    events: LEDGER_ABI.filter((x) => x.type === "event" && (x.name === "CashDeposited" || x.name === "CashWithdrawn")),
    fromBlock, toBlock,
  }), "cash");
  return logs.map((l) => ({
    kind: l.eventName === "CashDeposited" ? ("cashDeposit" as const) : ("cashWithdraw" as const),
    account: (l.args as { account: Address }).account,
    amount: (l.args as { amount: bigint }).amount,
    bankRef: (l.args as { bankRef: Hex }).bankRef,
    ref: { txHash: l.transactionHash!, block: l.blockNumber!, logIndex: l.logIndex! },
  }));
}

// ── CAFECA 帳戶的金鑰與模組事件（簽章模型：不用 archive 節點，改從事件重建） ──

export const CAFECA_ABI = parseAbi([
  "event KeyAdded(address indexed account, bytes32 indexed keyId, uint8 kind)",
  "event KeyRemoved(address indexed account, bytes32 indexed keyId)",
  "event ModuleInstalled(uint256 moduleTypeId, address module)",
  "event ModuleUninstalled(uint256 moduleTypeId, address module)",
  "function getKey(address account, bytes32 keyId) view returns (bytes32 qx, bytes32 qy, bytes32 rpIdHash, uint8 kind, uint64 addedAt)",
]);

/// keyring 的 KeyAdded／KeyRemoved（全部帳戶；量不大）。
export async function readKeyLogs(client: PublicClient, keyring: Address, range: Range) {
  const logs = await getLogsPaged(client, range, (fromBlock, toBlock) => client.getLogs({
    address: keyring, events: CAFECA_ABI.filter((x) => x.type === "event" && (x.name === "KeyAdded" || x.name === "KeyRemoved")),
    fromBlock, toBlock,
  }), `keys-${keyring.toLowerCase().slice(2, 10)}`);
  return logs.map((l) => ({
    kind: l.eventName === "KeyAdded" ? ("added" as const) : ("removed" as const),
    account: (l.args as { account: Address }).account, keyId: (l.args as { keyId: Hex }).keyId,
    block: l.blockNumber!, txHash: l.transactionHash!, logIndex: l.logIndex!,
  }));
}

/// 這些帳戶自己發出的 ModuleInstalled／ModuleUninstalled。
export async function readModuleLogs(client: PublicClient, accounts: Address[], range: Range) {
  if (accounts.length === 0) return [];
  const out = [];
  for (let i = 0; i < accounts.length; i += 50) {
    const batch = accounts.slice(i, i + 50);
    // 帳戶清單會變：索引檔以這一批帳戶的雜湊命名，多了新帳戶就是另一份（新的那份從頭讀一次）
    const tag = keccak256(toBytes(batch.map((a) => a.toLowerCase()).sort().join(","))).slice(2, 10);
    const logs = await getLogsPaged(client, range, (fromBlock, toBlock) => client.getLogs({
      address: batch, events: CAFECA_ABI.filter((x) => x.type === "event" && (x.name === "ModuleInstalled" || x.name === "ModuleUninstalled")),
      fromBlock, toBlock,
    }), `modules-${tag}`);
    for (const l of logs) {
      const a = l.args as { moduleTypeId: bigint; module: Address };
      out.push({ kind: l.eventName === "ModuleInstalled" ? ("installed" as const) : ("uninstalled" as const), account: l.address as Address, moduleType: a.moduleTypeId, module: a.module, block: l.blockNumber!, logIndex: l.logIndex! });
    }
  }
  return out;
}
