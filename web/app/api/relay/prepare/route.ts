import { isHex, type Hex } from "viem";
import { passkeyAccountAbi } from "@/lib/abis";
import { isAddress, publicClient } from "@/lib/server/chain";
import { handle, HttpError, requireRole } from "@/lib/server/roles";
import { callsFor, walletOf, type Intent } from "@/lib/server/wallet";

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
///
/// 兩種輸入：
///   · `calls`  — 一般交易（買、賣、註銷）。呼叫端自己組好。
///   · `intent` — 帳戶對自己下的指令（加裝置、撤裝置、解凍、否決復原）。
///     由伺服器端編 calldata 並回傳，呼叫端原封不動帶去 /api/relay。
///     這類指令編錯一個位元組就是一筆做了別的事的交易，不該交給瀏覽器組。
type WireCall = { target: string; value: string; data: string };

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { account?: string; calls?: WireCall[]; intent?: Intent };

    let account = body.account;
    let typed: { target: `0x${string}`; value: bigint; data: Hex }[];
    let mode: "execute" | "self" = "execute";

    if (body.intent) {
      // intent 一律綁**目前登入者自己的**錢包，不看呼叫端給的地址：
      // 金鑰管理是這個系統裡最敏感的一組操作，沒有理由讓它接受外來的目標地址。
      const m = await requireRole("user");
      const w = await walletOf(m.email, m.id);
      if (!w.exists) throw new HttpError(400, "還沒有鏈上錢包");
      account = w.address;
      typed = callsFor(w.address, body.intent);
      mode = "self";
    } else {
      const calls = body.calls;
      if (!isAddress(account) || !Array.isArray(calls) || calls.length === 0) {
        throw new HttpError(400, "bad request");
      }
      typed = calls.map((c) => {
        if (!isAddress(c.target) || !isHex(c.data)) throw new HttpError(400, "bad call");
        return { target: c.target, value: BigInt(c.value ?? "0"), data: c.data as Hex };
      });
    }

    // 帳戶不在這條鏈上（多半是重新部署過）是**可預期**的狀態，不是錯誤：
    // 呼叫端據此重新建立，再問一次。用 409 而不是 500，
    // 是為了讓它在前端的 catch 裡不必去比對字串。
    const code = await publicClient.getCode({ address: account as `0x${string}` });
    if (!code || code === "0x") return Response.json({ error: "no-code" }, { status: 409 });

    const nonce = await publicClient.readContract({
      address: account as `0x${string}`, abi: passkeyAccountAbi, functionName: "nonce",
    });
    const digest = await publicClient.readContract({
      address: account as `0x${string}`, abi: passkeyAccountAbi, functionName: "getDigest", args: [typed, nonce],
    });
    return Response.json({
      account, mode, nonce: nonce.toString(), digest,
      calls: typed.map((c) => ({ target: c.target, value: c.value.toString(), data: c.data })),
    });
  } catch (e) { return handle(e); }
}
