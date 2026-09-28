import { CHAIN_ID } from "@/lib/server/chain";
import { requireRole } from "@/lib/server/roles";
import { ApiError, handleError, ok } from "@/lib/server/api";
import { readConfig, readStatus, simulationAllowed, simulationChains, writeConfig } from "@/lib/server/mm";

/// 後台做市的控制面。只有管理員。
///
/// 這支 API **只寫設定檔**，不送任何交易：啟停、撥款上限、收回資金，全部由常駐程式
/// （`npm run mm`）在下一輪讀到之後執行。所以回應裡的「已儲存」代表設定寫進去了，
/// 不代表已經生效——生效與否看 status 的心跳與 action。

export async function GET() {
  try {
    await requireRole("admin");
    return ok({
      chainId: CHAIN_ID,
      simulationAllowed: simulationAllowed(),
      simulationChains: simulationChains(),
      config: readConfig(),
      ...readStatus(),
    });
  } catch (e) { return handleError(e); }
}

const EDITABLE = [
  "capitalTWD", "maxInventoryTonnes", "maxOrderTonnes", "levels", "spreadBps", "stepBps",
  "anchorPricePerTonne", "floorPerTonne", "ceilPerTonne", "maxDailyLossTWD", "requoteBps",
  "intervalSec", "minFillTonnes",
] as const;

/// POST { action: "save", config: {...} } | { action: "start" | "stop" | "recall" | "resume" }
///      | { action: "simulation", enabled, users?, intervalSec? }
export async function POST(req: Request) {
  try {
    const m = await requireRole("admin");
    const body = await req.json().catch(() => ({}));
    const by = m.handle ?? m.address;
    const action = String(body.action ?? "");
    let config;
    switch (action) {
      case "save": {
        const patch: Record<string, unknown> = {};
        for (const k of EDITABLE) if (body.config?.[k] !== undefined) patch[k] = Number(body.config[k]);
        config = writeConfig(patch, by);
        break;
      }
      case "start": config = writeConfig({ enabled: true }, by); break;
      case "stop": config = writeConfig({ enabled: false }, by); break;
      // 一次性指令用遞增的時間戳：常駐程式記得處理過哪一個，同一個指令不會被執行兩次
      case "recall": config = writeConfig({ commands: { recall: Date.now() } }, by); break;
      case "resume": config = writeConfig({ commands: { resume: Date.now() } }, by); break;
      case "simulation": {
        const sim: Record<string, unknown> = { enabled: body.enabled === true };
        if (body.users !== undefined) sim.users = Number(body.users);
        if (body.intervalSec !== undefined) sim.intervalSec = Number(body.intervalSec);
        config = writeConfig({ simulation: sim }, by);
        break;
      }
      default:
        throw new ApiError("INVALID_PARAM", "action 必須是 save / start / stop / recall / resume / simulation", { param: "action" });
    }
    return ok({ config, ...readStatus() });
  } catch (e) { return handleError(e); }
}
