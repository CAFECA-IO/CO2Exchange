import { createWalletClient, http, type Hex } from "viem";
import { feeScheduleAbi, registryAbi } from "@/lib/abis";
import { countryCode, countryToBytes2 } from "@/lib/deployment";
import { chain, deployment, documentSigner, publicClient, RPC_URL } from "@/lib/server/chain";
import { requireRole } from "@/lib/server/roles";
import { ApiError, handleError, ok } from "@/lib/server/api";
import { submit } from "@/lib/server/tx";

/// 各國費率表。
///
/// GET 是公開的——使用者本來就該知道自己要付多少手續費，不必登入才看得到。
/// POST 需要管理員，並以 PRICING_ROLE 的服務金鑰（Phase 0 = DOCUMENT_SIGNER_PK）送交易。

export async function GET() {
  try {
    const d = deployment();
    if (!d.feeSchedule) return ok({ enabled: false, rows: [] });
    const [defaultTradeBps, defaultRetireFeePerTonne, codes] = await Promise.all([
      publicClient.readContract({ address: d.feeSchedule, abi: feeScheduleAbi, functionName: "defaultTradeBps" }),
      publicClient.readContract({ address: d.feeSchedule, abi: feeScheduleAbi, functionName: "defaultRetireFeePerTonne" }),
      publicClient.readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "countries" }),
    ]);
    const rows = await Promise.all(codes.map(async (c) => {
      const [j, fee] = await Promise.all([
        publicClient.readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "jurisdictionOf", args: [c] }),
        publicClient.readContract({ address: d.feeSchedule, abi: feeScheduleAbi, functionName: "countryFeeOf", args: [c] }),
      ]);
      return {
        country: countryCode(c), name: j.name, scheme: j.scheme, enabled: j.enabled, domestic: j.domestic,
        custom: fee.set,
        tradeBps: fee.set ? fee.tradeBps : Number(defaultTradeBps),
        retireFeePerTonne: (fee.set ? fee.retireFeePerTonne : defaultRetireFeePerTonne).toString(),
      };
    }));
    return ok({
      enabled: true,
      defaultTradeBps: Number(defaultTradeBps),
      defaultRetireFeePerTonne: defaultRetireFeePerTonne.toString(),
      rows,
    });
  } catch (e) { return handleError(e); }
}

/// POST { country, custom, tradeBps, retireFeePerTonne } → 設定單一轄區
/// POST { defaults: true, tradeBps, retireFeePerTonne }   → 設定預設值
export async function POST(req: Request) {
  try {
    await requireRole("admin");
    const body = await req.json();
    const d = deployment();
    if (!d.feeSchedule) throw new ApiError("DEPLOYMENT_MISMATCH", "這個部署沒有費率表合約");
    const signer = documentSigner;
    const wallet = createWalletClient({ chain, account: signer, transport: http(RPC_URL) });

    const tradeBps = Number(body.tradeBps ?? 0);
    const retire = BigInt(Math.round(Number(body.retireFeePerTonne ?? 0) * 1e6));
    if (!Number.isInteger(tradeBps) || tradeBps < 0 || tradeBps > 500)
      throw new ApiError("INVALID_PARAM", "交易手續費須為 0–500 bps（上限 5%）", { param: "tradeBps" });
    if (retire < 0n) throw new ApiError("INVALID_PARAM", "註銷手續費不可為負", { param: "retireFeePerTonne" });

    // 兩種寫入分開送：合併成三元運算式會讓 viem 推不出型別（兩個 request 的型別不同）
    let hash: Hex;
    if (body.defaults) {
      const { request } = await publicClient.simulateContract({
        address: d.feeSchedule, abi: feeScheduleAbi, functionName: "setDefaults",
        args: [tradeBps, retire], account: signer,
      });
      hash = (await submit(request, wallet)).hash;
    } else {
      const { request } = await publicClient.simulateContract({
        address: d.feeSchedule, abi: feeScheduleAbi, functionName: "setCountryFee",
        args: [countryToBytes2(String(body.country)), !!body.custom, tradeBps, retire], account: signer,
      });
      hash = (await submit(request, wallet)).hash;
    }
    return ok({ txHash: hash });
  } catch (e) { return handleError(e); }
}
