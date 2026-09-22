import { passkeyAccountAbi } from "@/lib/abis";
import { publicClient, relayerClient } from "@/lib/server/chain";
import { handle, HttpError, requireRole } from "@/lib/server/roles";
import { walletOf } from "@/lib/server/wallet";

/// 掛失。只要**登得進來**就按得下去。
///
/// 門檻為什麼這麼低：需要凍結的那一刻，使用者手上多半已經沒有那台裝置了——
/// 手機掉在計程車上、筆電被偷。這時候還要求「用另一把 passkey 簽字」，
/// 等於在最需要止血的時候把止血帶鎖起來。所以凍結由平台 relayer 代送，
/// 授權只要登入。
///
/// 代價說清楚：拿到你 Google 帳號的人也按得下去，他可以讓你的錢包不能交易。
/// 這是**阻斷服務**，不是盜領——因為解凍走的是另一條路（/api/relay/prepare
/// 的 unfreeze，要一把現存 passkey 簽字），而他沒有。凍結期間他也動不了任何一分錢。
/// 往安全的方向動，門檻低；往開鎖的方向動，門檻高。這個不對稱是刻意的。
export async function POST() {
  try {
    const m = await requireRole("user");
    const w = await walletOf(m.email, m.id);
    if (!w.exists) throw new HttpError(400, "還沒有鏈上錢包");
    if (w.frozen) return Response.json({ ...w, alreadyFrozen: true });

    const { request } = await publicClient.simulateContract({
      address: w.address, abi: passkeyAccountAbi, functionName: "freeze", account: relayerClient.account,
    });
    const txHash = await relayerClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    return Response.json({ ...(await walletOf(m.email, m.id)), txHash });
  } catch (e) { return handle(e); }
}
