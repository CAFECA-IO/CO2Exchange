import { isHex, type Hex } from "viem";
import { passkeyAccountAbi } from "@/lib/abis";
import { isAddress, publicClient } from "@/lib/server/chain";
import { handle } from "@/lib/server/roles";

/// 簽章前要問鏈的那兩件事：這個帳戶的 nonce，以及這批 call 對應的 digest。
///
/// 為什麼不讓瀏覽器自己讀：**前端不直接跟區塊鏈說話**，所有鏈上讀寫都經過這裡。
/// 理由不只是分層好看——
///   · 節點位址不必外流。以前 /api/config 會把 RPC 位址發給每一個訪客，
///     等於把節點暴露在公開網路上，任何人都能拿它發請求。
///   · 瀏覽器連得到的節點，和伺服器連得到的節點，本來就不一定是同一個
///     （內網節點、IP 白名單、公司防火牆），兩邊各讀一次就會各看到一條鏈。
///   · digest 是用 lib/abis 的 ABI 算的。ABI 只留在伺服器端，合約改版時
///     不必擔心某個使用者的瀏覽器還快取著舊的那一份。
///
/// 這支不簽任何東西，也不送交易：私鑰是裝置上的 passkey，簽章永遠在瀏覽器裡發生。
/// 這裡只回答「要簽的是哪一串 bytes」。
type Call = { target: string; value: string; data: string };

export async function POST(req: Request) {
  try {
    const { account, calls } = (await req.json()) as { account?: string; calls?: Call[] };
    if (!isAddress(account) || !Array.isArray(calls) || calls.length === 0) {
      return Response.json({ error: "bad request" }, { status: 400 });
    }
    const typed = calls.map((c) => {
      if (!isAddress(c.target) || !isHex(c.data)) throw new Error("bad call");
      return { target: c.target, value: BigInt(c.value ?? "0"), data: c.data as Hex };
    });

    // 帳戶不在這條鏈上（多半是重新部署過）是**可預期**的狀態，不是錯誤：
    // 呼叫端據此用同一把 passkey 重綁，再問一次。用 409 而不是 500，
    // 是為了讓它在前端的 catch 裡不必去比對字串。
    const code = await publicClient.getCode({ address: account });
    if (!code || code === "0x") return Response.json({ error: "no-code" }, { status: 409 });

    const nonce = await publicClient.readContract({
      address: account, abi: passkeyAccountAbi, functionName: "nonce",
    });
    const digest = await publicClient.readContract({
      address: account, abi: passkeyAccountAbi, functionName: "getDigest", args: [typed, nonce],
    });
    return Response.json({ nonce: nonce.toString(), digest });
  } catch (e) { return handle(e); }
}
