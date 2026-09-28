#!/usr/bin/env node
// k-of-n 授權事件的提案工具（簽章模型方案 B：主權、營運、查核角色）。
//
//   npm run ledger:authority -- list
//   npm run ledger:authority -- propose fees '{"country":"TW","tradeBps":"150n","retireFeePerTonne":"30000000n"}' --note "調整臺灣費率"
//   npm run ledger:authority -- show <id>                       # 印出要簽的 EIP-712（給硬體錢包或任何錢包簽）
//   npm run ledger:authority -- sign <id> --key-env MY_OWNER_PK # 用「你自己 shell 裡」的私鑰簽（只印地址）
//   npm run ledger:authority -- add-signature <id> 0x…         # 匯入在別處簽好的簽章
//   npm run ledger:authority -- submit <id>                     # 收滿門檻就寫進帳本
//   npm run ledger:authority -- cancel <id>
//
// 持有人的私鑰**不放在 web/.env.local**：`sign` 只讀你在這個 shell 明確指定的環境變數，
// 而且只印出地址。正式環境建議用 `show` 把 EIP-712 交給硬體錢包簽，再 `add-signature`。
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keyring, setting } from "./lib/keys.mjs";

const { openStore } = await import("../lib/ledger/store.ts");
const { readAuthorities } = await import("../lib/ledger/chain.ts");
const { reviver, replacer } = await import("../lib/ledger/events.ts");
const P = await import("../lib/ledger/proposals.ts");

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(`--${n}`); return i > -1 ? rest[i + 1] : undefined; };

const RPC = setting("RPC_URL") ?? "http://127.0.0.1:28545";
const pub = createPublicClient({ transport: http(RPC) });
const chainId = await pub.getChainId();
const LOCAL = chainId === 31337 || chainId === 1337;
const D = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`), "utf8"));
if (D.ledgerVersion !== 2) { console.error("部署檔不是帳本 v2"); process.exit(1); }
const domains = { chainId, ledger: D.ledger };
const DATA = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
const LEDGER_DIR = process.env.LEDGER_DIR ?? path.join(DATA, "ledger");
const now = () => pub.getBlockNumber({ cacheTime: 0 });
const auth = () => readAuthorities(pub, D.ledger, { fromBlock: BigInt(D.deployedAtBlock ?? 0) });
const print = (p, progress) => console.log(`${p.id}  ${p.kind.padEnd(14)} ${p.role.padEnd(10)} ${p.status.padEnd(9)} ${progress ? `${progress.collected}/${progress.required}` : ""}  ${p.note}`);

try {
  switch (cmd) {
    case "list": {
      const a = await auth(); const b = await now();
      const ps = P.listProposals(LEDGER_DIR);
      if (!ps.length) console.log("沒有提案");
      for (const p of ps) print(p, P.progressOf(p, a, b));
      break;
    }
    case "propose": {
      const kind = rest[0];
      const body = JSON.parse(rest[1] ?? "{}", reviver);
      const p = P.createProposal(LEDGER_DIR, domains, { kind, body, createdBy: "cli", note: flag("note") ?? "" });
      const pr = P.progressOf(p, await auth(), await now());
      console.log(`建立提案 ${p.id}（${p.role}，需要 ${pr.required} 個簽章）\ndigest ${p.digest}\n可簽署的持有人：${pr.pending.join(", ")}`);
      break;
    }
    case "show": {
      const p = P.readProposal(LEDGER_DIR, rest[0]);
      console.log(JSON.stringify({ proposal: p, typedData: P.typedDataOf(domains, p) }, replacer, 2));
      break;
    }
    case "sign": {
      const env = flag("key-env");
      if (!env) throw new Error("要指定 --key-env <環境變數名稱>（私鑰放在你自己的 shell，不放 web/.env.local）");
      const pk = process.env[env];
      if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error(`環境變數 ${env} 沒有有效的私鑰`);
      const a = privateKeyToAccount(pk);
      const p0 = P.readProposal(LEDGER_DIR, rest[0]);
      const sig = await a.signTypedData(P.typedDataOf(domains, p0));
      const p = await P.addSignature(LEDGER_DIR, p0.id, sig, await auth(), await now());
      const pr = P.progressOf(p, await auth(), await now());
      console.log(`${a.address} 已簽署提案 ${p.id}（${pr.collected}/${pr.required}）`);
      break;
    }
    case "add-signature": {
      const p = await P.addSignature(LEDGER_DIR, rest[0], rest[1], await auth(), await now());
      const pr = P.progressOf(p, await auth(), await now());
      console.log(`已加入 ${p.signatures.at(-1).signer} 的簽章（${pr.collected}/${pr.required}）`);
      break;
    }
    case "submit": {
      const ring = keyring({ chainId, isLocal: LOCAL });
      const receiptSigner = privateKeyToAccount(ring.require("RECEIPT_SIGNER_PK", "RELAYER_PK").pk);
      const { event } = await P.submitProposal(LEDGER_DIR, rest[0], { store: openStore(LEDGER_DIR), authorities: await auth(), atBlock: await now(), receiptSigner });
      console.log(`提案 ${rest[0]} 已寫進帳本第 ${event.seq} 筆`);
      break;
    }
    case "cancel":
      P.cancelProposal(LEDGER_DIR, rest[0]);
      console.log(`提案 ${rest[0]} 已取消`);
      break;
    default:
      console.log("用法：list | propose <kind> <json> [--note …] | show <id> | sign <id> --key-env VAR | add-signature <id> <sig> | submit <id> | cancel <id>");
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
