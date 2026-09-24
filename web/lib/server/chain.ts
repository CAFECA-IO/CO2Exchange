import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Deployment } from "../deployment";

// Anvil account0：Phase 0 同時是 relayer、身分驗證服務、營運角色。正式環境三者分開並放 HSM。
const ANVIL_PK0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:28545";
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);

/// 只有這兩個 chainId 算「這台機器自己的鏈」。其餘一律當公開鏈處理。
/// 白名單而不是黑名單：漏掉一條公開鏈的代價是金鑰外洩，漏掉一條本機鏈的代價是多設一個環境變數。
export const IS_LOCAL_CHAIN = CHAIN_ID === 31337 || CHAIN_ID === 1337;

/// 這把金鑰在任何別人也連得到的鏈上都不能用。
///
/// ANVIL_PK0 印在 anvil 的啟動畫面上，全世界都有。它在這個系統裡同時是 relayer
/// （能凍結任何人的錢包）、身分驗證服務（能替任何人簽發 KYC attestation）、
/// 以及碳權查驗機構（能核發額度）。在公開測試鏈上用它，等於把這三件事開放給所有人。
///
/// 所以在**啟動時**就丟出來，不要等到第一筆交易。少一個環境變數而整條鏈默默地
/// 可以被任何人操作，是這次換鏈最容易犯、也最難發現的錯。
export function requireOwnKey(envName: string, pk: string | undefined): string {
  if (IS_LOCAL_CHAIN) return pk ?? ANVIL_PK0;
  if (!pk) {
    throw new Error(
      `chainId ${CHAIN_ID} 不是本機測試鏈，但沒有設定 ${envName}。` +
        `公開鏈上每一個服務金鑰都要是這條鏈專用的，不能沿用 Anvil 預設帳戶（那把金鑰是公開的）。` +
        `請在 web/.env.local 設定 ${envName}，見 README「部署到公開測試鏈」。`,
    );
  }
  if (pk.toLowerCase() === ANVIL_PK0) {
    throw new Error(
      `${envName} 用的是 Anvil 的預設金鑰，而 chainId ${CHAIN_ID} 不是本機測試鏈。` +
        `那把金鑰印在 anvil 的啟動畫面上，任何人都有——它在這裡能凍結錢包、簽發身分、核發額度。` +
        `請換成這條鏈專用的金鑰。`,
    );
  }
  return pk;
}

export const chain = defineChain({
  id: CHAIN_ID,
  name: process.env.CHAIN_NAME ?? "TideBit-DeFi Carbon Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const relayer = privateKeyToAccount(requireOwnKey("RELAYER_PK", process.env.RELAYER_PK) as Hex);
export const identityVerifier = privateKeyToAccount(
  requireOwnKey("IDENTITY_VERIFIER_PK", process.env.IDENTITY_VERIFIER_PK ?? process.env.RELAYER_PK) as Hex,
);

/// 本機鏈當場出塊，等 4 秒等於白等 4 秒（viem 的預設值）——一年份的回填因此從
/// 四小時變四分鐘。公開鏈的出塊是真的要等，問太快只是把 RPC 供應商的額度燒掉，
/// 而公開 RPC 幾乎都有速率限制。所以這個值跟著鏈走。
const POLLING_MS = IS_LOCAL_CHAIN ? 50 : 1_000;

/// 等幾個確認才算數。本機鏈沒有重組，1 個就是最終；公開測試鏈上仍可能有淺重組，
/// 但這是展示環境，等到天荒地老不值得——1 個確認 + 逾時保護是這裡的取捨。
export const CONFIRMATIONS = Number(process.env.TX_CONFIRMATIONS ?? 1);

/// 一筆交易最多等多久。本機是「出不來就是壞了」，公開鏈要留給塞車。
export const TX_TIMEOUT_MS = Number(process.env.TX_TIMEOUT_MS ?? (IS_LOCAL_CHAIN ? 30_000 : 120_000));

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: POLLING_MS });
export const relayerClient = createWalletClient({ chain, account: relayer, transport: http(RPC_URL) });

/// 以檔案 mtime 當快取鍵：重新部署會改寫這個檔，下一次呼叫就自動重讀。
///
/// 原本只快取一次，結果重新部署之後伺服器還抓著舊地址，對著鏈上不存在的合約發
/// eth_call，回 "0x"，錯誤訊息完全看不出是這個原因。每次多一個 statSync
/// 換掉整類問題，划算。
let cached: { mtimeMs: number; file: string; value: Deployment } | undefined;

export function deploymentFile(): string {
  return process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${CHAIN_ID}.json`);
}

export function deployment(): Deployment {
  const file = deploymentFile();
  if (!fs.existsSync(file)) {
    throw new Error(`找不到部署檔 ${file}，請先執行 forge script script/DeployV4.s.sol --rpc-url anvil --broadcast`);
  }
  const { mtimeMs } = fs.statSync(file);
  if (cached && cached.file === file && cached.mtimeMs === mtimeMs) return cached.value;
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Deployment;
  cached = { mtimeMs, file, value };
  return value;
}

/// 文件服務金鑰（PDF 回寫、費率設定）。沒設就沿用 relayer——它已經過同一道閘門。
/// 設了就要是這條鏈自己的金鑰，公開鏈上不接受 Anvil 預設值。
export const documentSigner = process.env.DOCUMENT_SIGNER_PK
  ? privateKeyToAccount(requireOwnKey("DOCUMENT_SIGNER_PK", process.env.DOCUMENT_SIGNER_PK) as Hex)
  : relayer;

export function isAddress(x: unknown): x is Address {
  return typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
}
