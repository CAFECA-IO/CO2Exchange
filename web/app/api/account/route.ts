import { type Hex, isHex } from "viem";
import { accountFactoryAbi } from "@/lib/abis";
import { deployment, isAddress, publicClient, relayerClient } from "@/lib/server/chain";
import { getAccount, putAccount } from "@/lib/server/accounts";
import { auth } from "@/auth";
import { handle } from "@/lib/server/roles";

/// GET ?credentialId= → 既有帳戶
/// GET ?address=      → 這個地址在目前這條鏈上有沒有合約
///
/// 後者是給前端問「我記住的地址還算數嗎」用的。**前端不直接跟區塊鏈說話**，
/// 所以 eth_getCode 也走這裡，而不是讓瀏覽器自己開一條 RPC。
export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const address = u.searchParams.get("address");
    if (address) {
      if (!isAddress(address)) return Response.json({ error: "address" }, { status: 400 });
      const code = await publicClient.getCode({ address });
      return Response.json({ address, exists: !!code && code !== "0x" });
    }
    const id = u.searchParams.get("credentialId") ?? "";
    const row = getAccount(id);
    return row ? Response.json(row) : Response.json({ error: "unknown credential" }, { status: 404 });
  } catch (e) { return handle(e); }
}

/// POST { credentialId, publicKey } → 以 passkey 公鑰決定地址；未部署則由 relayer 代為部署（平台付 gas）
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { credentialId, publicKey } = (await req.json()) as { credentialId?: string; publicKey?: string };
  if (!credentialId || !isHex(publicKey) || publicKey.length !== 130) {
    return Response.json({ error: "publicKey must be 64-byte hex (x||y)" }, { status: 400 });
  }
  try {
  const qx = `0x${publicKey.slice(2, 66)}` as Hex;
  const qy = `0x${publicKey.slice(66, 130)}` as Hex;
  const d = deployment();
  const address = await publicClient.readContract({ address: d.accountFactory, abi: accountFactoryAbi, functionName: "getAddress", args: [qx, qy] });

  const code = await publicClient.getCode({ address });
  let txHash: Hex | undefined;
  if (!code || code === "0x") {
    txHash = await relayerClient.writeContract({ address: d.accountFactory, abi: accountFactoryAbi, functionName: "createAccount", args: [qx, qy] });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
  }
  putAccount(credentialId, { publicKey: publicKey as Hex, address });
  return Response.json({ address, deployed: !!txHash, txHash });
  } catch (e) { return handle(e); }
}
