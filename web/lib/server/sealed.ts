import "server-only";
import { DEV_DATA_KEY_TEXT as DEV_KEY_TEXT, aadOf, open, parseDataKey, seal, SealedError, type DataKey } from "@/lib/crypto/sealed";
import { ApiError } from "./api";
import { IS_LOCAL_CHAIN } from "./chain";

/// 網站這一側的個人資料加密：身分證號、統編、姓名、收款帳號與戶名。
///
/// 金鑰：`DATA_KEY`（web/.env.local，`bash script/bootstrap.sh keys` 產生，只印「已產生」不印值）。
/// 換金鑰時把舊的放進 `DATA_KEY_PREVIOUS`（可以逗號分隔多把），新寫入一律用 `DATA_KEY`，
/// 舊資料照樣讀得到；再跑一次 `npm run data:protect -- --rekey` 把舊資料改用新金鑰。
///
/// **本機鏈**沒設金鑰時用一把由固定字串推出的展示金鑰（和 anvil 的預設帳戶同一個道理：公開、只限本機）。
/// **外部鏈**沒設金鑰就拒絕保存個人資料（`DATA_KEY_MISSING`），不會退回明文。
///
/// 金鑰遺失＝加密的資料全部讀不回來（收款帳戶要請使用者重設、待審的身分申請要重送）。
/// 所以金鑰要**另外**備份，而且不要和 web/data 的備份放在一起——放在一起就等於沒加密。

let cached: { current: DataKey; all: DataKey[] } | null = null;

function keys(): { current: DataKey; all: DataKey[] } {
  if (cached) return cached;
  const text = process.env.DATA_KEY?.trim();
  if (!text && !IS_LOCAL_CHAIN) {
    throw new ApiError("DATA_KEY_MISSING", "伺服器沒有設定資料加密金鑰（DATA_KEY），不能保存個人資料。執行 bash script/bootstrap.sh keys 產生。");
  }
  let current: DataKey;
  try { current = parseDataKey(text || DEV_KEY_TEXT); } catch (e) { throw new ApiError("DATA_KEY_MISSING", (e as Error).message); }
  const previous = (process.env.DATA_KEY_PREVIOUS ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((t) => {
    try { return parseDataKey(t); } catch (e) { throw new ApiError("DATA_KEY_MISSING", `DATA_KEY_PREVIOUS：${(e as Error).message}`); }
  });
  // 本機鏈：換過金鑰之後，之前用展示金鑰寫的資料仍然讀得到
  const dev = IS_LOCAL_CHAIN && text ? [parseDataKey(DEV_KEY_TEXT)] : [];
  cached = { current, all: [current, ...previous, ...dev] };
  return cached;
}

export const sealField = (collection: string, field: string, account: string, value: string) =>
  seal(value, keys().current, aadOf(collection, field, account));

export function openField(collection: string, field: string, account: string, sealed: string): string {
  try {
    return open(sealed, keys().all, aadOf(collection, field, account));
  } catch (e) {
    if (e instanceof SealedError) throw new ApiError("DATA_KEY_MISMATCH", e.message);
    throw e;
  }
}
