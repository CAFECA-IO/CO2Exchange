#!/usr/bin/env node
// 新台幣入出金的營運工具（規則第 4 版）：營運 Safe 在鏈上確認入金與出金。
//
//   npm run fiat -- list                                    # 待出金的帳戶、可確認多少、收款帳戶雜湊
//   npm run fiat -- code <地址>                             # 這個帳戶的入金識別碼（匯款備註）
//   npm run fiat -- deposit <地址或入金識別碼> <元> <銀行交易參考號>
//   npm run fiat -- settle <地址> <元> <匯款交易參考號>
//   … --print                                               # 不送出：印出營運 Safe 要執行的 to / data（交給硬體錢包或 govern.sh）
//
// 簽章：營運 Safe 持有人的金鑰只從 repo 根目錄的 .governance.env（或 shell 的 OPERATOR_OWNER_<n>_PK）讀，
// 不讀 web/.env.local；只印地址。本機鏈用 anvil 的公開測試金鑰。送出 execTransaction 的 gas 由
// DEPLOYER_PK（沒有就 RELAYER_PK）付，它不必是持有人。
//
// 金額單位是**元**（可到小數六位）。銀行交易參考號只以雜湊上鏈（bankRef），同一個參考號合約不收第二次。
// 退回出金請求是帳本裡的營運授權事件：npm run ledger:authority -- propose withdrawReject '{"account":"0x…","amount":"…n","reason":"…"}'
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { KeyError, keyring, operatorOwnerAccounts, setting } from "./lib/keys.mjs";

const { openStore } = await import("../lib/ledger/store.ts");
const { apply, genesis } = await import("../lib/ledger/engine.ts");
const { readCommitments, LEDGER_ABI, PROOF_ABI } = await import("../lib/ledger/chain.ts");
const { snapshotAt, balanceProofArgs } = await import("../lib/ledger/proofs.ts");
const { mirrorCash } = await import("../lib/ledger/mirror.ts");
const F = await import("../lib/ledger/fiat.ts");

const [cmd, ...args] = process.argv.slice(2).filter((a) => a !== "--print");
const PRINT = process.argv.includes("--print");

const RPC = setting("RPC_URL") ?? "http://127.0.0.1:28545";
const pub0 = createPublicClient({ transport: http(RPC) });
const chainId = await pub0.getChainId().catch(() => { console.error(`連不上 ${RPC}`); process.exit(1); });
const LOCAL = chainId === 31337 || chainId === 1337;
const chain = defineChain({ id: chainId, name: "co2x", nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const D = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`), "utf8"));
if ((D.ledgerVersion ?? 0) < 3) { console.error("部署檔不是目前版本的帳本（需要 ledgerVersion 3：新台幣入出金版）"); process.exit(1); }
const DATA = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
// 鏈上事件的增量索引（web/data/chain-index），和網站共用
const { deploymentIndex } = await import("../lib/ledger/logindex.ts");
const IDX = deploymentIndex({ dataDir: DATA, chainId, ledger: D.ledger, deployedAt: D.deployedAt, local: chainId === 31337 || chainId === 1337 });
const store = openStore(process.env.LEDGER_DIR ?? path.join(DATA, "ledger"));

const yuan = (s) => {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(s ?? "").replace(/,/g, ""));
  if (!m) throw new Error(`金額要是元（例如 1000 或 1000.5）：${s}`);
  const v = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  if (v <= 0n) throw new Error("金額要大於 0");
  return v;
};
const fmt = (u) => (Number(u) / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 6 });
const stateNow = () => { const s = genesis(); apply(s, store.read(), { sigOk: () => true }); return s; };

function accountOf(who, s) {
  if (isAddress(who)) return who;
  const code = String(who).replace(/\D/g, "");
  for (const a of new Set([...s.identities.keys(), ...s.cash.keys(), ...s.credits.keys()])) {
    if (F.depositCodeOf(a) === code) return s.identities.get(a)?.account ?? a;
  }
  throw new Error(`找不到入金識別碼 ${who} 對應的帳戶`);
}

async function signers() {
  let sender;
  try {
    const ring = keyring({ chainId, isLocal: LOCAL });
    sender = privateKeyToAccount(ring.require("DEPLOYER_PK", "RELAYER_PK").pk);
  } catch (e) { if (e instanceof KeyError) { console.error(e.message); process.exit(1); } throw e; }
  const owners = await operatorOwnerAccounts({ isLocal: LOCAL });
  if (owners.length === 0) {
    console.error("這台機器上沒有營運 Safe 持有人的金鑰（repo 根目錄的 .governance.env，OPERATOR_OWNER_<n>_PK）。改用 --print 取得要執行的內容，交給持有人簽。");
    process.exit(1);
  }
  console.log(`營運 Safe ${D.operatorSafe}；持有人 ${owners.map((a) => a.address).join(", ")}；gas 由 ${sender.address} 付`);
  return { sender: createWalletClient({ account: sender, chain, transport: http(RPC) }), owners };
}

async function refuseUsed(bankRef) {
  if (await pub.readContract({ address: D.ledger, abi: LEDGER_ABI, functionName: "bankRefUsed", args: [bankRef] })) throw new Error("這個銀行交易參考號已經確認過了（合約不收第二次）");
}

async function run(call, label) {
  if (PRINT) {
    console.log(JSON.stringify({ safe: D.operatorSafe, to: call.to, value: "0", data: call.data, operation: 0 }, null, 2));
    console.log("\n用 script/govern.sh 走 Safe 簽章：\n  H=$(./script/govern.sh safe operator hash <to> <data>)\n  S=$(./script/govern.sh sign $H --ledger)\n  ./script/govern.sh safe operator exec <to> <data> 0x持有人:$S");
    return;
  }
  const { sender, owners } = await signers();
  const tx = await F.execOperatorSafe({ pub, sender, safe: D.operatorSafe, to: call.to, data: call.data, owners });
  const { added } = await mirrorCash({ store, client: pub, ledger: D.ledger, fromBlock: BigInt(D.deployedAtBlock ?? 0), index: IDX });
  console.log(`${label}：${tx}（帳本鏡像 ${added.length} 筆）`);
}

try {
  switch (cmd) {
    case "code": {
      if (!isAddress(args[0])) throw new Error("要給地址");
      console.log(F.depositCodeOf(args[0]));
      break;
    }
    case "list": {
      const s = stateNow();
      const commits = await readCommitments(pub, D.ledger, { fromBlock: BigInt(D.deployedAtBlock ?? 0), index: IDX });
      const snap = commits.length ? snapshotAt(store.read(), commits.at(-1)) : null;
      const rows = [...s.pendingWithdraw].filter(([, v]) => v > 0n);
      if (!rows.length) console.log("沒有待出金");
      for (const [a, pending] of rows) {
        const account = s.identities.get(a)?.account ?? a;
        const proof = snap ? balanceProofArgs(snap, account) : null;
        const withdrawn = await pub.readContract({ address: D.ledger, abi: PROOF_ABI, functionName: "withdrawnTotal", args: [account] });
        const settleable = proof && proof.leafRequested > withdrawn ? proof.leafRequested - withdrawn : 0n;
        const last = store.read().filter((e) => e.kind === "withdraw" && e.account.toLowerCase() === a).at(-1);
        console.log(`${account}  待出金 ${fmt(pending)} 元  可確認 ${fmt(settleable)} 元  收款帳戶雜湊 ${last?.payoutRef ?? "—"}`);
      }
      console.log("\n收款帳戶的明文在網站的 /admin「出入金」頁（管理員），或 web/data/payout-accounts.json。");
      break;
    }
    case "deposit": {
      const [who, amt, ref] = args;
      if (!who || !amt || !ref) throw new Error("用法：deposit <地址或入金識別碼> <元> <銀行交易參考號>");
      const account = accountOf(who, stateNow());
      const amount = yuan(amt);
      console.log(`入金 ${fmt(amount)} 元 → ${account}（入金識別碼 ${F.depositCodeOf(account)}）`);
      await refuseUsed(F.bankRefOf("in", ref));
      await run(F.creditDepositCall(D.ledger, account, amount, F.bankRefOf("in", ref)), "已確認入金");
      break;
    }
    case "settle": {
      const [account, amt, ref] = args;
      if (!isAddress(account) || !amt || !ref) throw new Error("用法：settle <地址> <元> <匯款交易參考號>");
      const amount = yuan(amt);
      const commits = await readCommitments(pub, D.ledger, { fromBlock: BigInt(D.deployedAtBlock ?? 0), index: IDX });
      if (!commits.length) throw new Error("還沒有任何一期承諾上鏈");
      const snap = snapshotAt(store.read(), commits.at(-1));
      const proof = balanceProofArgs(snap, account);
      if (!proof) throw new Error("最新一期承諾裡沒有這個帳戶");
      const withdrawn = await pub.readContract({ address: D.ledger, abi: PROOF_ABI, functionName: "withdrawnTotal", args: [account] });
      const settleable = proof.leafRequested > withdrawn ? proof.leafRequested - withdrawn : 0n;
      if (amount > settleable) throw new Error(`可確認的只有 ${fmt(settleable)} 元（出金請求要先進承諾）`);
      console.log(`出金 ${fmt(amount)} 元 ← ${account}（第 ${commits.at(-1).epoch} 期的證據）`);
      await refuseUsed(F.bankRefOf("out", ref));
      await run(F.settleWithdrawalCall(D.ledger, account, amount, F.bankRefOf("out", ref), proof), "已確認出金");
      break;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 17).join("\n").replace(/^\/\/ ?/gm, ""));
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`!! ${e.shortMessage ?? e.message}`);
  process.exit(1);
}
