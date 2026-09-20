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

export const chain = defineChain({
  id: CHAIN_ID,
  name: process.env.CHAIN_NAME ?? "TideBit-DeFi Carbon Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const relayer = privateKeyToAccount((process.env.RELAYER_PK ?? ANVIL_PK0) as Hex);
export const identityVerifier = privateKeyToAccount((process.env.IDENTITY_VERIFIER_PK ?? process.env.RELAYER_PK ?? ANVIL_PK0) as Hex);

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
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

export function isAddress(x: unknown): x is Address {
  return typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
}
