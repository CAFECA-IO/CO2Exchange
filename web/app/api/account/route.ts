import { type Hex, isHex } from "viem";
import { accountFactoryAbi } from "@/lib/abis";
import { deployment, publicClient, relayerClient } from "@/lib/server/chain";
import { getAccount, putAccount } from "@/lib/server/accounts";
import { auth } from "@/auth";
import { handle } from "@/lib/server/roles";

/// GET ?credentialId= → 既有帳戶
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("credentialId") ?? "";
  const row = getAccount(id);
  return row ? Response.json(row) : Response.json({ error: "unknown credential" }, { status: 404 });
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
