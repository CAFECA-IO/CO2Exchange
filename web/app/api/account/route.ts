import { type Hex } from "viem";
import { accountFactoryAbi } from "@/lib/abis";
import { deployment, isAddress, publicClient, relayerClient } from "@/lib/server/chain";
import { keyByCredential, putKey } from "@/lib/server/accounts";
import { requireRole } from "@/lib/server/roles";
import { ApiError, fail, handleError, ok } from "@/lib/server/api";
import { keyIdOf, splitPublicKey, walletOf } from "@/lib/server/wallet";
import { submit } from "@/lib/server/tx";

/// 這個登入帳號的錢包。**一個登入帳號一個錢包**，所以這裡不再回「帳戶清單」。
///
/// GET                 → 這個登入帳號的錢包（地址、金鑰、凍結狀態、復原提案）
/// GET ?address=       → 這個地址在目前這條鏈上有沒有合約
/// GET ?credentialId=  → 這把 passkey 對應到哪個錢包（discoverable credential 登入用）
///
/// 全部走這裡而不是讓瀏覽器自己讀鏈：**前端不直接跟區塊鏈說話**。
export async function GET(req: Request) {
  try {
    const u = new URL(req.url);

    const address = u.searchParams.get("address");
    if (address) {
      if (!isAddress(address)) return fail("INVALID_ADDRESS", { details: { param: "address" } });
      const code = await publicClient.getCode({ address });
      return ok({ address, exists: !!code && code !== "0x" });
    }

    const credentialId = u.searchParams.get("credentialId");
    if (credentialId) {
      const row = keyByCredential(credentialId);
      return row
        ? ok({ address: row.address, publicKey: row.publicKey, keyId: row.keyId, label: row.label })
        : fail("CREDENTIAL_NOT_FOUND", { details: { credentialId } });
    }

    const m = await requireRole("user");
    return ok(await walletOf(m.email, m.id));
  } catch (e) { return handleError(e); }
}

/// POST { credentialId, publicKey, label? }
///
/// 兩種情況，回傳分得出來：
///   · 錢包還不存在 → relayer 代為部署（平台付 gas），這把 passkey 成為第一把金鑰。
///   · 錢包已經存在 → **不動它的金鑰**。要多加一把裝置，得由現有的金鑰簽字
///     （走 /api/relay/prepare 的 addKey），不是誰送一把公鑰上來就能換鎖。
///     這一條就是「登入被盜 ≠ 錢包被盜」的實作依據：盜用者登得進來、
///     看得到餘額，但他手上沒有任何一把現存 passkey，加不了自己的金鑰。
export async function POST(req: Request) {
  try {
    const m = await requireRole("user");
    const { credentialId, publicKey, label } = (await req.json()) as
      { credentialId?: string; publicKey?: string; label?: string };
    if (!credentialId || !publicKey) throw new ApiError("MISSING_PARAM", "credentialId 與 publicKey 必填", { params: ["credentialId", "publicKey"] });
    const { qx, qy } = splitPublicKey(publicKey);
    const keyId = keyIdOf(qx, qy);
    const name = (label ?? "這台裝置").slice(0, 64);

    const before = await walletOf(m.email, m.id);
    const d = deployment();

    if (!before.exists) {
      const { request } = await publicClient.simulateContract({
        address: d.accountFactory, abi: accountFactoryAbi, functionName: "createAccount",
        args: [before.accountRef, qx, qy, name], account: relayerClient.account,
      });
      const { hash: txHash } = await submit(request);
      putKey({
        credentialId, publicKey: publicKey as Hex, keyId, accountRef: before.accountRef,
        address: before.address, label: name, userId: m.id, email: m.email,
      });
      return ok({ ...(await walletOf(m.email, m.id)), created: true, txHash, keyId });
    }

    // 錢包已經在鏈上。這把金鑰已經註冊過的話，補上本機對照就好——
    // 這正是「清掉瀏覽器資料後重新登入」會走到的路徑，而它不該要求使用者做任何事。
    const known = before.keys.find((k) => k.keyId.toLowerCase() === keyId.toLowerCase());
    if (known) {
      putKey({
        credentialId, publicKey: publicKey as Hex, keyId, accountRef: before.accountRef,
        address: before.address, label: known.label || name, userId: m.id, email: m.email,
      });
      return ok({ ...(await walletOf(m.email, m.id)), created: false, keyId });
    }

    // 新的一把金鑰，但錢包已經有主人了。**不能**就這樣加進去——
    // 可以的話，拿到你 Google 帳號的人只要登入、建一把自己的 passkey，
    // 就直接成為錢包的共同持有人。所以它進待核准區，等某一台現有裝置簽字。
    putKey({
      credentialId, publicKey: publicKey as Hex, keyId, accountRef: before.accountRef,
      address: before.address, label: name, userId: m.id, email: m.email, pending: true,
    });
    return ok({ ...(await walletOf(m.email, m.id)), created: false, keyId, needsExistingKey: true });
  } catch (e) { return handleError(e); }
}
