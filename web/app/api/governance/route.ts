import { keccak256, toBytes, type Address } from "viem";
import { accessControlAbi, safeViewAbi, timelockAbi } from "@/lib/abis";
import { deployment, publicClient } from "@/lib/server/chain";
import { requireRole } from "@/lib/server/roles";
import { handleError, ok } from "@/lib/server/api";
import { readAuthorities } from "@/lib/ledger/chain";
import { thresholdAt } from "@/lib/ledger/authorities";
import { openProposals } from "@/lib/server/ledger/write";

const ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const SOV = keccak256(toBytes("SOVEREIGN_ROLE")); const OP = keccak256(toBytes("OPERATOR_ROLE"));
const PROPOSER = keccak256(toBytes("PROPOSER_ROLE")); const EXECUTOR = keccak256(toBytes("EXECUTOR_ROLE")); const CANCELLER = keccak256(toBytes("CANCELLER_ROLE"));
const STATE = ["Unset", "Waiting", "Ready", "Done"];

/// 管理員：govern.sh status 的網頁版 + Timelock 待執行操作
export async function GET() {
  try {
    await requireRole("admin");
    const d = deployment();
    const has = (a: Address, role: `0x${string}`, who: Address) => publicClient.readContract({ address: a, abi: accessControlAbi, functionName: "hasRole", args: [role, who] });
    const common = () => Promise.all([
      publicClient.readContract({ address: d.nationalSafe, abi: safeViewAbi, functionName: "getOwners" }),
      publicClient.readContract({ address: d.nationalSafe, abi: safeViewAbi, functionName: "getThreshold" }),
      publicClient.readContract({ address: d.operatorSafe, abi: safeViewAbi, functionName: "getOwners" }),
      publicClient.readContract({ address: d.operatorSafe, abi: safeViewAbi, functionName: "getThreshold" }),
      publicClient.readContract({ address: d.timelock, abi: timelockAbi, functionName: "getMinDelay" }),
    ]);
    const timelockOps = async () => {
      const scheduled = await publicClient.getLogs({ address: d.timelock, event: timelockAbi[3], fromBlock: BigInt(d.deployedAtBlock ?? 0) });
      return Promise.all(scheduled.map(async (l) => {
        const id = l.args.id!;
        const [st, ts] = await Promise.all([
          publicClient.readContract({ address: d.timelock, abi: timelockAbi, functionName: "getOperationState", args: [id] }),
          publicClient.readContract({ address: d.timelock, abi: timelockAbi, functionName: "getTimestamp", args: [id] }),
        ]);
        return { id, target: l.args.target, data: l.args.data, state: STATE[st], readyAt: Number(ts), txHash: l.transactionHash };
      }));
    };

    // 鏈上只剩帳本合約＋治理。角色矩陣只有一列，另外列出授權金鑰清單（信任根）
    const ledger = d.ledger;
    const COMMITTER = keccak256(toBytes("COMMITTER_ROLE"));
    const [natOwners, natThreshold, opOwners, opThreshold, delay] = await common();
    const auth = await readAuthorities(publicClient, ledger, { fromBlock: BigInt(d.deployedAtBlock ?? 0) });
    const head = await publicClient.getBlockNumber({ cacheTime: 0 });
    const tlRoles = { proposer: await has(d.timelock, PROPOSER, d.nationalSafe), executor: await has(d.timelock, EXECUTOR, d.nationalSafe), canceller: await has(d.timelock, CANCELLER, d.nationalSafe) };
    return ok({
      ledger: {
        address: ledger,
        committer: d.committer ?? null,
        committerOk: d.committer ? await has(ledger, COMMITTER, d.committer) : null,
        authorities: auth.grants.filter((g) => g.until === null).map((g) => ({ role: g.role, account: g.account, since: g.from })),
        thresholds: Object.fromEntries((["SOVEREIGN", "OPERATOR", "AUDITOR"] as const).map((r) => [r, thresholdAt(auth, r, head)])),
        proposals: await openProposals(),
      },
      matrix: [{ name: "ledger", address: ledger, admin: await has(ledger, ADMIN, d.timelock), sovereign: await has(ledger, SOV, d.nationalSafe), operator: await has(ledger, OP, d.operatorSafe) }],
      nationalSafe: { address: d.nationalSafe, owners: natOwners, threshold: Number(natThreshold) },
      operatorSafe: { address: d.operatorSafe, owners: opOwners, threshold: Number(opThreshold) },
      timelock: { address: d.timelock, delay: Number(delay), ...tlRoles, operations: (await timelockOps()).reverse() },
    });
  } catch (e) { return handleError(e); }
}
