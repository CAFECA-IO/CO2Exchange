import { isHex, type Hex } from "viem";
import { dropKey, keyById, putKey } from "@/lib/server/accounts";
import { handle, HttpError, requireRole } from "@/lib/server/roles";
import { walletOf } from "@/lib/server/wallet";

/// 待核准的新裝置：核准之後的**善後**，以及拒絕。
///
/// 核准這個動作本身不在這裡——它是一筆要用現有 passkey 簽字的鏈上交易
/// （/api/relay/prepare 的 addKey intent）。這支只負責在那筆交易成功之後
/// 把「待核准」的旗標拿掉，以及讓使用者一鍵拒絕一個他沒發起的請求。
///
/// 拒絕為什麼重要：看到「有新裝置要求加入你的錢包」而那不是你，這是
/// 帳號被盜的**第一個徵兆**。此時該做的是拒絕它，然後立刻掛失（凍結）。
/// 畫面會把這兩件事放在一起。

async function target(req: Request) {
  const m = await requireRole("user");
  const keyId = new URL(req.url).searchParams.get("keyId") ?? (await req.json().catch(() => ({}))).keyId;
  if (!isHex(keyId) || keyId.length !== 66) throw new HttpError(400, "keyId");
  const row = keyById(keyId as Hex);
  const w = await walletOf(m.email, m.id);
  if (!row || row.accountRef.toLowerCase() !== w.accountRef.toLowerCase()) throw new HttpError(404, "找不到這個請求");
  return { m, w, row, keyId: keyId as Hex };
}

/// 核准的交易送出成功之後呼叫：清掉 pending 旗標。
/// 以鏈為準——鏈上沒有這把金鑰就不清，免得畫面顯示「已核准」而其實沒有。
export async function POST(req: Request) {
  try {
    const { m, row, keyId } = await target(req);
    const after = await walletOf(m.email, m.id);
    if (!after.keys.some((k) => k.keyId.toLowerCase() === keyId.toLowerCase())) {
      throw new HttpError(409, "這把金鑰還沒上鏈，核准尚未生效");
    }
    putKey({ ...row, pending: false });
    return Response.json(await walletOf(m.email, m.id));
  } catch (e) { return handle(e); }
}

/// 拒絕：把對照刪掉。那把 passkey 還躺在那台裝置的 Keychain 裡，
/// 但它從來沒上過鏈，對這個錢包而言等於不存在。
export async function DELETE(req: Request) {
  try {
    const { m, keyId } = await target(req);
    dropKey(keyId);
    return Response.json(await walletOf(m.email, m.id));
  } catch (e) { return handle(e); }
}
