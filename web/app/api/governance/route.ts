import { keccak256, toBytes, type Address } from "viem";
import { accessControlAbi, hookViewAbi, listingWriteAbi, ownedAbi, safeViewAbi, timelockAbi } from "@/lib/abis";
import { deployment, publicClient } from "@/lib/server/chain";
import { hasV4 } from "@/lib/deployment";
import { requireRole } from "@/lib/server/roles";
import { handleError, ok } from "@/lib/server/api";

const ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const SOV = keccak256(toBytes("SOVEREIGN_ROLE")); const OP = keccak256(toBytes("OPERATOR_ROLE"));
const PROPOSER = keccak256(toBytes("PROPOSER_ROLE")); const EXECUTOR = keccak256(toBytes("EXECUTOR_ROLE")); const CANCELLER = keccak256(toBytes("CANCELLER_ROLE"));
const STATE = ["Unset", "Waiting", "Ready", "Done"];

/// 管理員：govern.sh status 的網頁版 + Timelock 待執行操作
export async function GET() {
  try {
    await requireRole("admin");
    const d = deployment() as ReturnType<typeof deployment> & { nationalSafe: Address; operatorSafe: Address; timelock: Address };
    const has = (a: Address, role: `0x${string}`, who: Address) => publicClient.readContract({ address: a, abi: accessControlAbi, functionName: "hasRole", args: [role, who] });
    const v4 = hasV4(d); // SKIP_V4 部署：沒有 PoolManager / hook / router
    const withOp = ([["kycRegistry", d.kycRegistry], ["retirementCertificate", d.retirementCertificate], ["listing", d.listing], ["carbonPool", d.carbonPool], ...(v4 ? [["hook", d.hook]] : [])] as [string, Address][]);
    const sovOnly = [["carbonCredit1155", d.carbonCredit1155], ["carbonRegistry", d.carbonRegistry]] as const;
    const matrix = [
      ...(await Promise.all(withOp.map(async ([n, a]) => ({ name: n, address: a, admin: await has(a, ADMIN, d.timelock), sovereign: await has(a, SOV, d.nationalSafe), operator: await has(a, OP, d.operatorSafe) })))),
      ...(await Promise.all(sovOnly.map(async ([n, a]) => ({ name: n, address: a, admin: await has(a, ADMIN, d.timelock), sovereign: await has(a, SOV, d.nationalSafe), operator: null })))),
      { name: "cct", address: d.cct, admin: await has(d.cct, ADMIN, d.timelock), sovereign: null, operator: null },
    ];
    const [pmOwner, listingPaused, poolPaused, trustedRouter, natOwners, natThreshold, opOwners, opThreshold, delay] = await Promise.all([
      v4 ? publicClient.readContract({ address: d.poolManager, abi: ownedAbi, functionName: "owner" }) : Promise.resolve(null),
      publicClient.readContract({ address: d.listing, abi: listingWriteAbi, functionName: "paused" }),
      publicClient.readContract({ address: d.carbonPool, abi: listingWriteAbi, functionName: "paused" }),
      v4 ? publicClient.readContract({ address: d.hook, abi: hookViewAbi, functionName: "trustedRouter" }) : Promise.resolve(null),
      publicClient.readContract({ address: d.nationalSafe, abi: safeViewAbi, functionName: "getOwners" }),
      publicClient.readContract({ address: d.nationalSafe, abi: safeViewAbi, functionName: "getThreshold" }),
      publicClient.readContract({ address: d.operatorSafe, abi: safeViewAbi, functionName: "getOwners" }),
      publicClient.readContract({ address: d.operatorSafe, abi: safeViewAbi, functionName: "getThreshold" }),
      publicClient.readContract({ address: d.timelock, abi: timelockAbi, functionName: "getMinDelay" }),
    ]);
    const tlRoles = { proposer: await has(d.timelock, PROPOSER, d.nationalSafe), executor: await has(d.timelock, EXECUTOR, d.nationalSafe), canceller: await has(d.timelock, CANCELLER, d.nationalSafe) };
    const scheduled = await publicClient.getLogs({ address: d.timelock, event: timelockAbi[3], fromBlock: 0n });
    const ops = await Promise.all(scheduled.map(async (l) => {
      const id = l.args.id!;
      const [st, ts] = await Promise.all([
        publicClient.readContract({ address: d.timelock, abi: timelockAbi, functionName: "getOperationState", args: [id] }),
        publicClient.readContract({ address: d.timelock, abi: timelockAbi, functionName: "getTimestamp", args: [id] }),
      ]);
      return { id, target: l.args.target, data: l.args.data, state: STATE[st], readyAt: Number(ts), txHash: l.transactionHash };
    }));
    return ok({
      hasV4: v4,
      matrix, poolManagerOwner: pmOwner, poolManagerOwnerIsTimelock: !!pmOwner && pmOwner.toLowerCase() === d.timelock.toLowerCase(),
      listingPaused, poolPaused, trustedRouter, swapsEnabled: !!trustedRouter && trustedRouter.toLowerCase() === d.router.toLowerCase(),
      nationalSafe: { address: d.nationalSafe, owners: natOwners, threshold: Number(natThreshold) },
      operatorSafe: { address: d.operatorSafe, owners: opOwners, threshold: Number(opThreshold) },
      timelock: { address: d.timelock, delay: Number(delay), ...tlRoles, operations: ops.reverse() },
    });
  } catch (e) { return handleError(e); }
}
