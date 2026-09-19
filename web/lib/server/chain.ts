import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Deployment } from "../deployment";

// Anvil account0：Phase 0 同時是 relayer、身分驗證服務、營運角色。正式環境三者分開並放 HSM。
const ANVIL_PK0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);

export const chain = defineChain({
  id: CHAIN_ID,
  name: process.env.CHAIN_NAME ?? "CO2Exchange Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const relayer = privateKeyToAccount((process.env.RELAYER_PK ?? ANVIL_PK0) as Hex);
export const identityVerifier = privateKeyToAccount((process.env.IDENTITY_VERIFIER_PK ?? process.env.RELAYER_PK ?? ANVIL_PK0) as Hex);

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
export const relayerClient = createWalletClient({ chain, account: relayer, transport: http(RPC_URL) });

let cached: Deployment | undefined;
export function deployment(): Deployment {
  if (cached) return cached;
  const file = process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${CHAIN_ID}.json`);
  if (!fs.existsSync(file)) throw new Error(`找不到部署檔 ${file}，請先執行 forge script script/Deploy.s.sol --rpc-url anvil --broadcast`);
  cached = JSON.parse(fs.readFileSync(file, "utf8")) as Deployment;
  return cached;
}

export function isAddress(x: unknown): x is Address {
  return typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
}
