import { isHex, type Hex } from "viem";
import { passkeyAccountAbi } from "@/lib/abis";
import { isAddress, publicClient, relayerClient } from "@/lib/server/chain";
import { fail, handleError, ok } from "@/lib/server/api";
import { submit } from "@/lib/server/tx";

/// revert 的拆解在 lib/server/revert.ts，和讀取那一側共用——
/// 「合約拒絕了」不該因為它發生在寫入還是讀取而得到不同的說法。

type Call = { target: string; value: string; data: string };

/// POST { account, calls, keyId, signature, mode? } → relayer 送出交易（平台付 gas）
///
/// `keyId` 說明這是**哪一把 passkey** 簽的。一個錢包可以有好幾把（手機一把、
/// 筆電一把），合約靠這個直接查，不必逐把試——逐把試會讓 gas 隨著裝置數上升。
///
/// `mode`：
///   · "execute"（預設）— 一般交易。帳戶凍結時一律擋下。
///   · "self"           — 帳戶對自己下的指令（加/撤裝置、解凍、否決復原）。
///     **凍結中仍然走得通**，否則掛失會把使用者自己鎖在門外。合約端另有白名單，
///     這條路碰不到任何會動錢的函式。
///
/// 授權來自使用者的 WebAuthn 簽章，relayer 無法竄改內容；
/// Phase 1 由 ERC-4337 bundler + paymaster 取代。
export async function POST(req: Request) {
  const { account, calls, keyId, signature, mode } = (await req.json()) as
    { account?: string; calls?: Call[]; keyId?: string; signature?: string; mode?: string };
  if (!isAddress(account) || !Array.isArray(calls) || !isHex(signature) || !isHex(keyId) || keyId.length !== 66) {
    return fail("INVALID_PARAM", {
      message: "account、calls、keyId 與 signature 都必填，且格式要正確",
      details: { params: ["account", "calls", "keyId", "signature"] },
    });
  }
  const fn = mode === "self" ? "executeSelf" : "execute";
  const typed = calls.map((c) => {
    if (!isAddress(c.target) || !isHex(c.data)) throw new Error("bad call");
    return { target: c.target, value: BigInt(c.value ?? "0"), data: c.data as Hex };
  });
  try {
    const { request } = await publicClient.simulateContract({
      address: account, abi: passkeyAccountAbi, functionName: fn, args: [typed, keyId, signature], account: relayerClient.account,
    });
    const { hash, receipt } = await submit(request);
    return ok({ txHash: hash, status: receipt.status, gasUsed: receipt.gasUsed });
  } catch (e) {
    // 合約 revert、節點連不上、部署檔對不上、未知例外——全部交給 handleError 分類。
    // 它會把 revert 拆成看得懂的原因並回 CONTRACT_REVERTED，
    // 所以這裡不再自己拆一份（自己拆的那一份曾經和讀取那一側說法不一致）。
    return handleError(e);
  }
}
