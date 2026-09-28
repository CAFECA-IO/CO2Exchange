import { keccak256, parseAbi, toBytes, type Address, type Hex, type PublicClient } from "viem";
import { ROLES, type Authorities, type Grant, type Role } from "./authorities.ts";
import type { EpochBoundary } from "./replay.ts";

/// 從帳本合約讀兩樣東西：授權金鑰清單的歷史、已經提交的承諾。
///
/// 兩樣都從**事件**讀，不從 storage 讀：授權清單要的是「某一把金鑰在哪一段區塊區間有效」，
/// storage 只知道現在；承諾的完整內容也只在事件裡一次給齊。
/// 不依賴 Next、不用路徑別名——查核機構要能單獨跑。

export const LEDGER_ABI = parseAbi([
  "event AuthorityGranted(bytes32 indexed role, address indexed account)",
  "event AuthorityRevoked(bytes32 indexed role, address indexed account)",
  "struct CommitInput { bytes32 prev; uint64 epoch; bytes32 logRoot; bytes32 balanceRoot; bytes32 registryRoot; bytes32 identityRoot; uint256 totalKg; uint256 totalCash; bytes32 totalsHash; uint64 upToBlock; uint64 lastSeq; uint16 rulesVersion; }",
  "event Committed(uint64 indexed epoch, bytes32 anchor, CommitInput commitment)",
  "event CashDeposited(address indexed account, uint256 amount)",
  "event CashWithdrawn(address indexed account, uint256 amount, uint64 epoch)",
  "event CreditClaimed(address indexed account, uint256 indexed batchId, uint256 amountKg, uint64 epoch, uint256 projectId, uint16 vintageYear, bytes32 serialHash)",
  "function head() view returns (bytes32)",
  "function epoch() view returns (uint64)",
  "function commit(CommitInput c) returns (bytes32)",
  "function anchorOf(CommitInput c) pure returns (bytes32)",
  "function depositCash(uint256 amount)",
  "function solvency() view returns (uint256 owedCash, uint256 heldCash, uint64 latestEpoch, uint64 committedAt)",
  "function escapeIn() view returns (uint256)",
  "function withdrawalsEnabled() view returns (bool)",
]);

const ROLE_BY_HASH = new Map<string, Role>(ROLES.map((r) => [keccak256(toBytes(r)).toLowerCase(), r]));

type Range = { fromBlock: bigint; toBlock?: bigint };

/// 授權清單的歷史 → 每一把金鑰、每一個角色的有效區間。
/// 同一把金鑰被撤銷後又重新授予，會得到兩段不相連的區間——那正是應該的樣子。
export async function readAuthorities(client: PublicClient, ledger: Address, range: Range): Promise<Authorities> {
  const logs = await client.getLogs({
    address: ledger,
    events: LEDGER_ABI.filter((x) => x.type === "event" && (x.name === "AuthorityGranted" || x.name === "AuthorityRevoked")),
    fromBlock: range.fromBlock, toBlock: range.toBlock ?? "latest",
  });
  logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber! < b.blockNumber! ? -1 : 1));
  const grants: Grant[] = [];
  const open = new Map<string, Grant>();
  for (const l of logs) {
    const args = l.args as { role: Hex; account: Address };
    const role = ROLE_BY_HASH.get(args.role.toLowerCase());
    if (!role) continue; // 不認得的角色（例如將來新增的）不影響現有規則
    const k = `${role}|${args.account.toLowerCase()}`;
    if (l.eventName === "AuthorityGranted" && !open.has(k)) {
      const g: Grant = { role, account: args.account, from: l.blockNumber!, until: null };
      grants.push(g); open.set(k, g);
    } else if (l.eventName === "AuthorityRevoked" && open.has(k)) {
      open.get(k)!.until = l.blockNumber!; open.delete(k);
    }
  }
  return { grants };
}

export type OnchainCommitment = EpochBoundary & {
  anchor: Hex; prev: Hex; logRoot: Hex; balanceRoot: Hex; registryRoot: Hex; identityRoot: Hex;
  totalKg: bigint; totalCash: bigint; totalsHash: Hex; rulesVersion: number; block: bigint; txHash: Hex;
};

export async function readCommitments(client: PublicClient, ledger: Address, range: Range): Promise<OnchainCommitment[]> {
  const logs = await client.getLogs({
    address: ledger, event: LEDGER_ABI.find((x) => x.type === "event" && x.name === "Committed") as never,
    fromBlock: range.fromBlock, toBlock: range.toBlock ?? "latest",
  });
  return (logs as unknown as { args: { anchor: Hex; commitment: Record<string, unknown> }; blockNumber: bigint; transactionHash: Hex }[]).map((l) => {
    const a = l.args;
    const c = a.commitment as {
      prev: Hex; epoch: bigint; logRoot: Hex; balanceRoot: Hex; registryRoot: Hex; identityRoot: Hex;
      totalKg: bigint; totalCash: bigint; totalsHash: Hex; upToBlock: bigint; lastSeq: bigint; rulesVersion: number;
    };
    return { ...c, anchor: a.anchor, block: l.blockNumber, txHash: l.transactionHash };
  }).sort((x, y) => (x.epoch < y.epoch ? -1 : 1));
}

/// 鏈上的結算幣存入／提領——帳本裡的 cashDeposit / cashWithdraw 要一筆一筆對得上它們。
export async function readCashEvents(client: PublicClient, ledger: Address, range: Range) {
  const logs = await client.getLogs({
    address: ledger,
    events: LEDGER_ABI.filter((x) => x.type === "event" && (x.name === "CashDeposited" || x.name === "CashWithdrawn")),
    fromBlock: range.fromBlock, toBlock: range.toBlock ?? "latest",
  });
  return logs.map((l) => ({
    kind: l.eventName === "CashDeposited" ? ("cashDeposit" as const) : ("cashWithdraw" as const),
    account: (l.args as { account: Address }).account,
    amount: (l.args as { amount: bigint }).amount,
    ref: { txHash: l.transactionHash!, block: l.blockNumber!, logIndex: l.logIndex! },
  }));
}
