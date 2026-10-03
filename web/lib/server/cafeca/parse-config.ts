import { isAddress, type Address } from "viem";
import { KNOWN_CAFECA } from "../../ledger/cafeca-identity.ts";

/// CAFECA 設定檔的解析。**獨立一支、不依賴 Next**，為的是它能被單獨測試。
///
/// 為什麼值得一支檔案：這是一份**從別的網域讀回來的 JSON**。它是資料，不是
/// 可以直接信任的結構——欄位可能改名、可能少、可能是別的型別。而解析錯的症狀
/// 很安靜：拿到一個空的合約地址，然後每一次簽章驗證都失敗，錯誤訊息說的是
/// 「身分合約不承認這個簽章」。
///
/// 這個 bug 真的發生過。第一版只讀平鋪的 `chainId` 與 `rpc`，是照一份**摘要過**的
/// 文件寫的；實際的設定檔把鏈放在 `chain: { id, rpc }` 底下。程式碼編得過、
/// 型別也對，只有在真的連上去的那一刻才會炸——而那時候人已經在部署了。
///
/// 教訓寫在這裡而不是 commit 訊息裡：**解析外部格式要照著原始位元組寫，不是照摘要。**

export type CafecaContracts = {
  factory: Address;
  keyring: Address;
  attestation: Address;
  recovery: Address;
  /// CAFECA 設定檔裡的結算幣（TWDC）。本站不用它：規則第 4 版起新台幣在信託專戶，帳本合約自己建立記帳 TWD。
  twdc?: Address;
  /// ERC-4337 EntryPoint。使用者的帳戶是 4337 帳戶，爭議處理時會用到。
  entryPoint?: Address;
  /// IdentityRegistry v2：實名狀態、主體類型（自然人／法人）、簽章者等級。**依賴方只讀這一支**，不讀 v1 attestation
  identityRegistry?: Address;
  /// 法人帳戶的 validator（成員以自己的 Passkey 代簽）。設定檔目前沒有公布，由環境變數或已知部署補上
  memberValidator?: Address;
};

export type CafecaConfig = {
  chainId: number;
  rpcUrl: string;
  contracts: CafecaContracts;
  /// 設定檔自稱的發行者。**只拿來提醒，不拿來做決定**——它可能是
  /// `http://localhost:10002`（開發版的錢包沒設 PUBLIC_ORIGIN 時就長這樣），
  /// 而那代表這份設定檔上的端點對外都不通。
  issuer?: string;
};

const optAddr = (v: unknown): Address | undefined =>
  typeof v === "string" && isAddress(v) ? (v as Address) : undefined;

export class ConfigError extends Error {}

const need = (v: unknown, name: string): Address => {
  const a = optAddr(v);
  if (!a) throw new ConfigError(`CAFECA 設定檔的 contracts.${name} 不是合法地址`);
  return a;
};

export function parseConfig(raw: unknown): CafecaConfig {
  const d = (raw ?? {}) as {
    issuer?: unknown;
    chainId?: unknown; rpc?: unknown; rpcUrl?: unknown;
    chain?: { id?: unknown; rpc?: unknown };
    contracts?: Record<string, unknown>;
  };

  // 兩種形狀都接受：巢狀的 `chain.{id,rpc}`（目前實際的樣子）與平鋪的
  // `chainId` / `rpc`。多寫兩行，換掉「哪天對方改格式就整站登不進去」。
  const chainId = Number(d.chain?.id ?? d.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new ConfigError("CAFECA 設定檔沒有合法的 chainId");
  }
  const rpcUrl = [d.chain?.rpc, d.rpc, d.rpcUrl].find((v) => typeof v === "string") as string | undefined;

  const c = d.contracts ?? {};
  return {
    chainId,
    rpcUrl: rpcUrl ?? "",
    issuer: typeof d.issuer === "string" ? d.issuer : undefined,
    contracts: {
      factory: need(c.factory, "factory"),
      keyring: need(c.keyring, "keyring"),
      attestation: need(c.attestation, "attestation"),
      recovery: need(c.recovery, "recovery"),
      twdc: optAddr(c.twdc),
      entryPoint: optAddr(c.entryPoint),
      identityRegistry: optAddr(c.identityRegistry),
      memberValidator: optAddr(c.memberValidator),
    },
  };
}

/// 這份設定檔的端點是不是只在某個人的電腦上通。
///
/// 開發版的錢包在沒設 `PUBLIC_ORIGIN` 時，`issuer` 與所有端點都會是
/// `http://localhost:10002`。那份設定檔的合約地址仍然是對的（它們在鏈上），
/// 但拿它上線，使用者的瀏覽器會被導去自己的 localhost。
/// 這種事要在啟動時就喊出來，不要等到有人登不進去才查。
export const looksLocal = (cfg: CafecaConfig): boolean =>
  /localhost|127\.0\.0\.1|\[::1\]/.test(cfg.issuer ?? "");

/// 環境變數 → 已知部署 → 設定檔，補齊兩支選用的合約。環境變數永遠優先（正式環境應該寫死）。
export function withOverrides(cfg: CafecaConfig, env: Record<string, string | undefined>): CafecaConfig {
  const known = KNOWN_CAFECA[cfg.chainId] ?? {};
  return {
    ...cfg,
    contracts: {
      ...cfg.contracts,
      identityRegistry: optAddr(env.CAFECA_IDENTITY_REGISTRY) ?? cfg.contracts.identityRegistry ?? known.identityRegistry,
      memberValidator: optAddr(env.CAFECA_MEMBER_VALIDATOR) ?? cfg.contracts.memberValidator ?? known.memberValidator,
    },
  };
}
