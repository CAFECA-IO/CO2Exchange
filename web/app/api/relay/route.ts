import { BaseError, ContractFunctionRevertedError, isHex, type Hex } from "viem";
import { passkeyAccountAbi } from "@/lib/abis";
import { isAddress, publicClient, relayerClient } from "@/lib/server/chain";

type Call = { target: string; value: string; data: string };

/// POST { account, calls, signature } → relayer 送出 PasskeyAccount.execute（平台付 gas）
/// 授權來自使用者的 WebAuthn 簽章，relayer 無法竄改內容；Phase 1 由 ERC-4337 bundler + paymaster 取代。
export async function POST(req: Request) {
  const { account, calls, signature } = (await req.json()) as { account?: string; calls?: Call[]; signature?: string };
  if (!isAddress(account) || !Array.isArray(calls) || !isHex(signature)) return Response.json({ error: "bad request" }, { status: 400 });
  const typed = calls.map((c) => {
    if (!isAddress(c.target) || !isHex(c.data)) throw new Error("bad call");
    return { target: c.target, value: BigInt(c.value ?? "0"), data: c.data as Hex };
  });
  try {
    const { request } = await publicClient.simulateContract({
      address: account, abi: passkeyAccountAbi, functionName: "execute", args: [typed, signature], account: relayerClient.account,
    });
    const hash = await relayerClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return Response.json({ txHash: hash, status: receipt.status, gasUsed: receipt.gasUsed.toString() });
  } catch (e) {
    let reason = e instanceof Error ? e.message : String(e);
    if (e instanceof BaseError) {
      const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
      reason = r?.data ? `${r.data.errorName}(${(r.data.args ?? []).map(String).join(",")})` : e.shortMessage;
    }
    return Response.json({ error: reason }, { status: 400 });
  }
}
