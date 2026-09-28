#!/usr/bin/env node
// 帳本 v2 的承諾工具：每小時一期（排程跑它）。
//
//   node --experimental-strip-types scripts/ledger-commit.mjs            # 算出下一期並提交
//   node --experimental-strip-types scripts/ledger-commit.mjs --plan     # 只算、不送
//   node --experimental-strip-types scripts/ledger-commit.mjs --verify   # 查核者：重播全部，逐期比對鏈上的 anchor
//
// 沒有新事件就不提交——但距離上一期超過 HEARTBEAT_AFTER 秒（預設 24 小時）時，照樣提交一期**空的**：
// 合約在 72 小時沒有新承諾之後開啟逃生艙（使用者可直接從合約提領），安靜的日子不該觸發它。
// 空的一期 lastSeq 與上一期相同、logRoot 是空樹，其餘 root 不變；它證明的是「這段時間帳本沒有動」。
//
// 送出之前一定先做完整驗證，任何一項不過就不送：
//   ① 已經上鏈的每一期，重播算出的 anchor 都等於鏈上那一個（否則帳本被動過）
//   ② 每一筆簽章都重驗過，而且**不讀任何歷史狀態**（不需要 archive 節點）：
//      授權事件 k-of-n ecrecover、簽章者在收單區塊有授權且達到門檻；
//      使用者事件 ecrecover 或 CAFECA WebAuthn（公鑰與有效區間來自鏈上事件）；收單區塊落在所屬那一期
//   ③ 鏈上的每一筆結算幣存入／提領，帳本裡都有而且只有一筆（反之亦然）
//   ④ 餘額樹的總現金不超過合約持有（合約也會擋，這裡先擋，錯誤訊息比較說得清楚）
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { KeyError, keyring, setting } from "./lib/keys.mjs";

const { openStore } = await import("../lib/ledger/store.ts");
const { replay } = await import("../lib/ledger/replay.ts");
const { loadKeyBook } = await import("../lib/ledger/keybook.ts");
const { readAuthorities, readCommitments, readCashEvents, LEDGER_ABI } = await import("../lib/ledger/chain.ts");
const { mirrorCash } = await import("../lib/ledger/mirror.ts");

const PLAN = process.argv.includes("--plan");
const VERIFY = process.argv.includes("--verify");

const RPC = setting("RPC_URL") ?? "http://127.0.0.1:28545";
const pub0 = createPublicClient({ transport: http(RPC) });
const chainId = await pub0.getChainId();
const LOCAL = chainId === 31337 || chainId === 1337;
const chain = defineChain({ id: chainId, name: "c", nativeCurrency: { name: "N", symbol: "N", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: LOCAL ? 50 : 1000 });
const D = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`), "utf8"));
if (D.ledgerVersion !== 2) { console.error("部署檔不是帳本 v2"); process.exit(1); }
const range = { fromBlock: BigInt(D.deployedAtBlock ?? 0) };
const domains = { chainId, ledger: D.ledger };
const DATA = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
const store = openStore(process.env.LEDGER_DIR ?? path.join(DATA, "ledger"));

const fail = (msg) => { console.error(`\n✗ ${msg}\n不提交。`); process.exit(1); };

const integrity = store.check();
if (!integrity.ok) fail(`帳本檔案本身不一致：${integrity.problem}`);
// 提交前先把還沒鏡像的鏈上存提補進帳本：它們由 ChainRef 背書，誰補都一樣，而漏掉的存入會讓③不過。
// 查核（--verify）與試算（--plan）不寫帳本。
if (!VERIFY && !PLAN) {
  const { added } = await mirrorCash({ store, client: pub, ledger: D.ledger, fromBlock: range.fromBlock });
  if (added.length) console.log(`  補鏡像 ${added.length} 筆鏈上存提`);
}
const events = store.read();
const [authorities, committed, cashOnChain, headBlock] = await Promise.all([
  readAuthorities(pub, D.ledger, range), readCommitments(pub, D.ledger, range), readCashEvents(pub, D.ledger, range), pub.getBlockNumber({ cacheTime: 0 }),
]);
console.log(`帳本 ${events.length} 筆；鏈上已提交 ${committed.length} 期；授權 ${authorities.grants.length} 筆`);

const HEARTBEAT_AFTER = BigInt(process.env.HEARTBEAT_AFTER ?? 86400);
const hasNew = events.length > Number(committed.at(-1)?.lastSeq ?? 0n);
let heartbeat = false;
if (!VERIFY && !hasNew && committed.length) {
  const [, , , committedAt] = await pub.readContract({ address: D.ledger, abi: LEDGER_ABI, functionName: "solvency" });
  const { timestamp } = await pub.getBlock({ blockNumber: headBlock });
  heartbeat = timestamp - committedAt >= HEARTBEAT_AFTER;
}
const next = !VERIFY && (hasNew || heartbeat)
  ? [{ epoch: BigInt(committed.length + 1), lastSeq: BigInt(events.length), upToBlock: headBlock }]
  : [];
if (heartbeat) console.log(`  距離上一期超過 ${HEARTBEAT_AFTER} 秒，提交一期空的（避免逃生艙誤開）`);
// 金鑰簿：CAFECA 帳戶的公鑰與有效區間全部來自事件（帳本的 userKey 鏡像＋鏈上 KeyAdded／KeyRemoved／模組事件），
// 不讀合約的歷史狀態——不需要 archive 節點。
const KEYRING = D.cafecaKeyring ?? setting("CAFECA_KEYRING") ?? null;
const { book, problems: keyProblems } = await loadKeyBook(pub, { keyring: KEYRING, events, toBlock: headBlock });
if (keyProblems.length) fail(`CAFECA 金鑰鏡像有問題：${keyProblems[0]}${keyProblems.length > 1 ? `（另有 ${keyProblems.length - 1} 筆）` : ""}`);
const r = await replay(events, { domains, authorities, keys: book, boundaries: [...committed, ...next] });

// ① 既有各期
for (const [i, c] of committed.entries()) {
  if (r.epochs[i].anchor !== c.anchor) fail(`第 ${c.epoch} 期：重播算出 ${r.epochs[i].anchor}，鏈上是 ${c.anchor}`);
}
if (committed.length) console.log(`  ✓ 已上鏈的 ${committed.length} 期 anchor 全部與重播一致`);
// ② 簽章
const bad = [...r.sig.entries()].filter(([, v]) => !v.ok);
if (bad.length) fail(`${bad.length} 筆簽章或授權驗不過，例如第 ${bad[0][0]} 筆：${bad[0][1].reason}`);
console.log(`  ✓ ${r.sig.size} 筆簽章離線重驗通過（授權 k-of-n、CAFECA 金鑰 ${[...book.keys.values()].flat().length} 把、收單區塊都在所屬期別內）`);
// ③ 存提
const key = (x) => `${x.kind}|${x.ref.txHash.toLowerCase()}|${x.ref.logIndex}|${x.account.toLowerCase()}|${x.amount}`;
const upTo = next[0]?.upToBlock ?? committed.at(-1)?.upToBlock ?? headBlock;
// 兩個方向的強度不同：
//   · 這一期之內（seq ≤ lastSeq）帳本宣稱的每一筆，鏈上都要有、而且在 upToBlock 之前——否則是憑空入金
//   · 鏈上 upToBlock 之前的每一筆，帳本裡都要有（可以是之後才鏡像的：那只是晚記，合約那邊多出來的是盈餘）
const lastSeq = next[0]?.lastSeq ?? committed.at(-1)?.lastSeq ?? BigInt(events.length);
const isCash = (e) => e.kind === "cashDeposit" || e.kind === "cashWithdraw";
const chainSet = new Map(cashOnChain.filter((c) => c.ref.block <= upTo).map((c) => [key(c), c]));
const logAll = new Map(events.filter(isCash).map((e) => [key(e), e]));
const logEpoch = [...logAll.entries()].filter(([, e]) => e.seq <= lastSeq);
for (const k of chainSet.keys()) if (!logAll.has(k)) fail(`鏈上有一筆存提帳本裡沒有：${k}`);
for (const [k] of logEpoch) if (!chainSet.has(k)) fail(`帳本宣稱的存提鏈上找不到：${k}`);
console.log(`  ✓ 結算幣存提 ${chainSet.size} 筆，鏈上與帳本逐筆相符`);

if (VERIFY) { console.log("\n查核完成：帳本與鏈上承諾一致。"); process.exit(0); }
if (!next.length) { console.log("\n沒有新事件，這一期不必提交。"); process.exit(0); }

const e = r.epochs.at(-1);
const [, held] = await pub.readContract({ address: D.ledger, abi: LEDGER_ABI, functionName: "solvency" });
if (e.roots.totalCash > held) fail(`帳本宣稱欠 ${e.roots.totalCash}，合約只持有 ${held}`);
const input = {
  prev: e.prev, epoch: e.epoch, logRoot: e.logRoot, balanceRoot: e.roots.balanceRoot, registryRoot: e.roots.registryRoot, identityRoot: e.roots.identityRoot,
  totalKg: e.roots.totalKg, totalCash: e.roots.totalCash, totalsHash: e.roots.totalsHash, upToBlock: e.upToBlock, lastSeq: e.lastSeq, rulesVersion: e.rulesVersion,
};
const onchain = await pub.readContract({ address: D.ledger, abi: LEDGER_ABI, functionName: "anchorOf", args: [input] });
if (onchain !== e.anchor) fail(`合約算的 anchor ${onchain} 與重播 ${e.anchor} 不同（公式不一致）`);
console.log(`\n第 ${e.epoch} 期：${e.lastSeq >= e.firstSeq ? `事件 ${e.firstSeq}–${e.lastSeq}` : "空的一期（沒有新事件）"}、到區塊 ${e.upToBlock}\n  anchor ${e.anchor}\n  碳權 ${e.roots.totalKg} kg、結算幣 ${e.roots.totalCash}（合約持有 ${held}）`);
if (PLAN) { console.log("\n（--plan，沒有送出）"); process.exit(0); }

let pk;
try { pk = keyring({ chainId, isLocal: LOCAL }).require("COMMITTER_PK", "RELAYER_PK", "DEPLOYER_PK").pk; }
catch (err) { if (err instanceof KeyError) { console.error(err.message); process.exit(1); } throw err; }
const w = createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(RPC) });
const hash = await w.writeContract({ address: D.ledger, abi: LEDGER_ABI, functionName: "commit", args: [input] });
const rc = await pub.waitForTransactionReceipt({ hash });
if (rc.status !== "success") fail(`交易失敗 ${hash}`);
console.log(`已提交第 ${e.epoch} 期，交易 ${hash}`);
