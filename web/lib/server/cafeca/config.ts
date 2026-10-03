import "server-only";
import { createPublicClient, defineChain, http, type Address, type PublicClient } from "viem";
import { CHAIN_ID, IS_LOCAL_CHAIN, publicClient } from "../chain";
import { ApiError } from "../api";
import { looksLocal, parseConfig, withOverrides, type CafecaConfig } from "./parse-config";

export type { CafecaConfig } from "./parse-config";

/// CAFECA 錢包的設定：這條鏈是哪一條、身分合約在哪裡。
///
/// ## 為什麼錢包網域只能來自環境變數
///
/// 這份設定決定了「我們要問哪一個合約：這個簽章有效嗎」。如果請求裡的任何一個欄位
/// 能影響到它，攻擊者就可以指向一個自己寫的合約，讓它對任何簽章都回 `0x1626ba7e`，
/// 於是任何人都能登入成任何人。所以 `CAFECA_WALLET` 只讀環境變數，
/// 而且底下每一個從遠端讀回來的欄位都要先驗過形狀才採用——
/// 遠端設定檔是**資料**，不是可以直接信任的程式碼。
export const WALLET_ORIGIN = (process.env.CAFECA_WALLET ?? "https://cafeca.io").replace(/\/+$/, "");

/// 設定檔讀不到時的退路。把值寫進環境變數就完全不碰網路——
/// 正式環境應該這樣做：登入能不能用，不該取決於另一個網域此刻醒著沒有。
function fromEnv(): CafecaConfig | null {
  const { CAFECA_CHAIN_ID, CAFECA_RPC_URL, CAFECA_ATTESTATION, CAFECA_RECOVERY, CAFECA_FACTORY, CAFECA_KEYRING } = process.env;
  if (!CAFECA_CHAIN_ID || !CAFECA_ATTESTATION) return null;
  return {
    chainId: Number(CAFECA_CHAIN_ID),
    rpcUrl: CAFECA_RPC_URL ?? "",
    contracts: {
      factory: (CAFECA_FACTORY ?? "0x") as Address,
      keyring: (CAFECA_KEYRING ?? "0x") as Address,
      attestation: CAFECA_ATTESTATION as Address,
      recovery: (CAFECA_RECOVERY ?? "0x") as Address,
    },
  };
}

/// 設定檔快取一小時。太短是拿別人的網域當每次登入的相依，太長則換約之後要重啟才生效。
const TTL_MS = 60 * 60_000;
let cached: { at: number; value: CafecaConfig } | undefined;

export async function cafecaConfig(): Promise<CafecaConfig> {
  const env = fromEnv();
  if (env) return withOverrides(env, process.env);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let raw: unknown;
  try {
    const r = await fetch(`${WALLET_ORIGIN}/.well-known/cafeca-configuration`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    raw = await r.json();
  } catch (e) {
    // 有舊的就先用舊的：設定檔一年也不會變一次，而登入不該因為對方短暫掛掉就全站停擺。
    if (cached) return cached.value;
    throw new ApiError("UPSTREAM_ERROR", `讀不到 CAFECA 設定檔（${WALLET_ORIGIN}）：${(e as Error).message}`);
  }

  let value: CafecaConfig;
  try {
    value = parseConfig(raw);
  } catch (e) {
    throw new ApiError("UPSTREAM_ERROR", (e as Error).message);
  }
  // 開發版的錢包沒設 PUBLIC_ORIGIN 時，設定檔上的端點全是 localhost。合約地址仍然
  // 是對的，但拿它上線，使用者的瀏覽器會被導去自己的電腦。在這裡喊一次，
  // 不要等到有人登不進去才查。
  if (looksLocal(value) && !IS_LOCAL_CHAIN) {
    console.warn(
      `[cafeca] ${WALLET_ORIGIN} 的設定檔 issuer 是 ${value.issuer}——這是開發版的錢包，` +
      `它上面的授權與簽章端點對外都不通。正式站要等對方設好 PUBLIC_ORIGIN。`,
    );
  }
  value = withOverrides(value, process.env);
  cached = { at: Date.now(), value };
  return value;
}

/// 要拿來驗簽章的那條鏈的 client。
///
/// 身分合約與交易所在**同一條鏈**時就用本站的 publicClient——我們控制得了那個節點，
/// 而且爭議時可以把同一段驗證搬到鏈上（委託單爭議需要）。
///
/// 兩者不同鏈時只能退回鏈下驗證：登入照樣成立（那本來就是一次 eth_call），
/// 但**鏈上驗不了**——合約沒辦法對另一條鏈發 eth_call。這是設定錯誤的徵兆，
/// 所以說出來，不要安靜地降級。
let identity: { rpc: string; client: PublicClient } | undefined;

export async function identityClient(): Promise<{ client: PublicClient; sameChain: boolean }> {
  const cfg = await cafecaConfig();
  if (cfg.chainId === CHAIN_ID) return { client: publicClient as PublicClient, sameChain: true };

  const rpc = cfg.rpcUrl;
  if (!rpc) {
    throw new ApiError(
      "UPSTREAM_ERROR",
      `CAFECA 身分在 chainId ${cfg.chainId}，本站在 ${CHAIN_ID}，而設定檔沒有給 RPC，驗不了簽章`,
    );
  }
  if (identity?.rpc !== rpc) {
    identity = {
      rpc,
      client: createPublicClient({
        chain: defineChain({
          id: cfg.chainId,
          name: "CAFECA Identity",
          nativeCurrency: { name: "Bolt", symbol: "BOLT", decimals: 18 },
          rpcUrls: { default: { http: [rpc] } },
        }),
        transport: http(rpc),
      }) as PublicClient,
    };
  }
  return { client: identity.client, sameChain: false };
}
