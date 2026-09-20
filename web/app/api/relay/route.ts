import { BaseError, ContractFunctionRevertedError, decodeErrorResult, isHex, type Abi, type Hex } from "viem";
import { passkeyAccountAbi } from "@/lib/abis";
import { errorAbi } from "@/lib/error-abi";
import { isAddress, publicClient, relayerClient } from "@/lib/server/chain";
import { handle, isChainUnreachable, isDeploymentMismatch } from "@/lib/server/roles";

/// `PasskeyAccount.execute` 失敗時丟的是 `CallFailed(index, reason)`——
/// 一個**信封**，真正的錯誤包在 reason 裡。不拆開的話，畫面上與 log 裡
/// 就只有一句 `CallFailed(0,0x…)`，甚至只有原始的四個位元組，
/// 使用者不知道是沒簽契約、KYC 過期、還是額度不夠。
///
/// 所以這裡把信封拆到底：用平台所有合約的 error 定義去比對 reason，
/// 解得出來就回那一個（例如 `PurposeNotAllowed(TW,2)`），
/// 解不出來才退回原始 bytes，並註明是第幾個 call 失敗的。
function unwrap(errorName: string, args: readonly unknown[]): string {
  if (errorName !== "CallFailed") {
    return args.length ? `${errorName}(${args.map(String).join(", ")})` : errorName;
  }
  const [index, reason] = args as [bigint, Hex];
  const at = `第 ${Number(index) + 1} 個動作`;
  if (!reason || reason === "0x") return `${at}失敗，合約沒有給原因（多半是 require 沒帶訊息，或 gas 不足）`;
  try {
    const d = decodeErrorResult({ abi: errorAbi as unknown as Abi, data: reason });
    const inner = d.args?.length ? `${d.errorName}(${d.args.map(String).join(", ")})` : d.errorName;
    return `${at}失敗：${inner}`;
  } catch {
    return `${at}失敗：${reason.slice(0, 10)}（沒有對應的 error 定義，可能是合約改過但 lib/error-abi.ts 沒重新產生）`;
  }
}

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
    // 環境問題（節點連不上、部署檔對不上）先分流，不要被當成合約 revert
    if (isChainUnreachable(e) || isDeploymentMismatch(e)) return handle(e);
    let reason = e instanceof Error ? e.message : String(e);
    if (e instanceof BaseError) {
      const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
      reason = r?.data ? unwrap(r.data.errorName, r.data.args ?? []) : e.shortMessage;
    }
    return Response.json({ error: reason }, { status: 400 });
  }
}
