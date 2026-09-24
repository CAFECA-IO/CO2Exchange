#!/usr/bin/env node
/**
 * 拿伺服器算出來的證據，**真的去問合約驗不驗得過**。
 *
 *   cd web
 *   node --experimental-strip-types scripts/check-proof-onchain.mjs --account 0x… --batch 1
 *
 * 為什麼要這一支：TS 建樹、Solidity 驗樹，兩邊的雜湊一致性已經有
 * `test/BankTree.t.sol` 用 fixture 守著。但那是在測試環境裡對照兩份實作，
 * 沒有經過**真的合約狀態**：commitments 裡存的 root、epoch 的比對、
 * 資產小樹的路徑，這些只有對著一條真的鏈才驗得到。
 *
 * 這一支用 `simulateContract` 呼叫 `withdraw`——模擬，不送出，不改狀態。
 * 提領功能關著的時候會先撞上 `WithdrawalsDisabled`，那本身就是一個有意義的結果：
 * 它代表證據結構被合約接受到「開關」那一步了。要完整驗到底，
 * 在本機鏈上暫時打開提領再跑一次。
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, defineChain, http, parseAbi } from "viem";

const { buildBalanceTree } = await import("../lib/bank/tree.ts");
const { deriveLedger } = await import("../lib/bank/ledger-core.ts");

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
};
const account = arg("account");
const batchId = BigInt(arg("batch") ?? "1");
const amount = BigInt(arg("amount") ?? "1");
if (!account) { console.error("要給 --account"); process.exit(1); }

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:28545";
const abi = parseAbi([
  "struct WithdrawProof { uint64 proofEpoch; bytes32 assetsRoot; uint256 leafKg; uint256 leafCash; Node[] siblings; uint256 path; uint256 batchKg; bytes32[] assetSiblings; uint256 assetPath; }",
  "struct Node { bytes32 hash; uint256 kg; uint256 cash; }",
  "function epoch() view returns (uint64)",
  "function commitments(uint64) view returns (bytes32,bytes32,uint256,uint256,bytes32,uint64,uint64)",
  "function withdrawalsEnabled() view returns (bool)",
  "function withdraw(uint256 batchId, uint256 amountKg, WithdrawProof p)",
  // error 也要放進 ABI，否則 viem 只回得出四個位元組的選擇器，
  // 而「合約拒絕了，代號 0x46ee9e35」對讀的人毫無幫助。
  "error WithdrawalsDisabled()",
  "error BadProof()",
  "error ZeroAmount()",
  "error NotLatestEpoch(uint64 latest, uint64 got)",
  "error SumMismatch(uint256 expected, uint256 got)",
  "error AlreadyWithdrawnThisEpoch(address account, uint64 epoch)",
  "error UnknownEpoch(uint64 epoch)",
]);

const pub0 = createPublicClient({ transport: http(RPC) });
const chainId = await pub0.getChainId();
const chain = defineChain({
  id: chainId, name: "co2x",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const client = createPublicClient({ chain, transport: http(RPC) });
const D = JSON.parse(fs.readFileSync(
  process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`), "utf8"));

const epoch = await client.readContract({ address: D.bank, abi, functionName: "epoch" });
const c = await client.readContract({ address: D.bank, abi, functionName: "commitments", args: [epoch] });
const balanceRoot = c[1];
const upToBlock = c[5];

const ledger = await deriveLedger({
  client, bank: D.bank, fromBlock: BigInt(D.deployedAtBlock ?? 0), toBlock: BigInt(upToBlock),
});
const tree = buildBalanceTree(ledger.balances, epoch);
if (tree.root.hash !== balanceRoot) {
  console.error(`重建的 root 和鏈上第 ${epoch} 期對不上，證據不會過。先跑 npm run bank:verify。`);
  process.exit(1);
}

const p = tree.proofOf(account);
const ap = tree.assetProofOf(account, batchId);
const proof = {
  proofEpoch: epoch,
  assetsRoot: p.assetsRoot,
  leafKg: p.leafKg,
  leafCash: p.leafCash,
  siblings: p.siblings.map((s) => ({ hash: s.hash, kg: s.kg, cash: s.cash })),
  path: p.path,
  batchKg: ap.kg,
  assetSiblings: ap.siblings,
  assetPath: ap.path,
};

console.log(`第 ${epoch} 期・${account}・批次 ${batchId}`);
console.log(`  葉子 ${p.leafKg} kg / ${p.leafCash}；兄弟 ${p.siblings.length} 個；資產樹兄弟 ${ap.siblings.length} 個`);
const enabled = await client.readContract({ address: D.bank, abi, functionName: "withdrawalsEnabled" });
console.log(`  提領開關：${enabled ? "開" : "關"}`);

try {
  await client.simulateContract({
    address: D.bank, abi, functionName: "withdraw", args: [batchId, amount, proof], account,
  });
  console.log("\n✓ 合約接受這份證據（模擬提領成功，沒有送出任何交易）");
} catch (e) {
  // 錯誤名稱藏在巢狀的 cause 裡（ContractFunctionRevertedError.data.errorName），
  // shortMessage 只有一句「reverted」。這和 lib/server/revert.ts 是同一個問題。
  let name = "";
  for (let cur = e, i = 0; cur && i < 8; i++, cur = cur.cause) {
    if (cur?.data?.errorName) { name = cur.data.errorName; break; }
    if (typeof cur?.signature === "string") name = cur.signature;
  }
  const msg = `${name || ""} ${String(e.shortMessage ?? e.message)}`.trim();
  if (name === "WithdrawalsDisabled" || /0x46ee9e35/.test(String(e.message))) {
    console.log("\n✓ 證據結構走到了提領開關那一步（開關是關的）");
    console.log("  要完整驗到底，在本機鏈上暫時打開提領再跑一次。");
  } else {
    console.error(`\n✗ 合約拒絕了這份證據：${msg}`);
    process.exit(1);
  }
}
