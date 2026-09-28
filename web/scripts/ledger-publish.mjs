#!/usr/bin/env node
// 發布（設計 v4 第 6 期）：每一期的公開檔，以及交給主管機關／查核機構的監理鏡像。
//
//   npm run ledger:publish                          # 公開檔寫到 web/data/public/（每期一個檔，已存在的不重寫）
//   npm run ledger:publish -- --out /srv/co2x-public
//   npm run ledger:publish -- --mirror /path/to/mirror   # 另外匯出完整帳本（監理鏡像）
//
// 公開檔（任何人）：承諾、每一筆事件的雜湊（可重算 logRoot）、登錄簿層事件全文與包含證據、
//   登錄簿狀態與葉子（可重算 registryRoot）、逐批次總量表。沒有個人資料。
// 監理鏡像（主管機關、查核機構）：完整帳本（events.jsonl ＋ head.json）與部署檔，附 SHA-256 清單。
//   收到的人自己跑查核：LEDGER_DIR=<鏡像>/ledger DEPLOYMENT_FILE=<鏡像>/deployment.json npm run ledger:verify
//
// 每一期的公開檔在寫出之前都先和鏈上的承諾比對（logRoot、registryRoot、balanceRoot…），對不上就不寫。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { setting } from "./lib/keys.mjs";

const { openStore } = await import("../lib/ledger/store.ts");
const { readCommitments } = await import("../lib/ledger/chain.ts");
const { publicEpoch } = await import("../lib/ledger/publish.ts");
const { snapshotAt, toJson } = await import("../lib/ledger/proofs.ts");

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const RPC = setting("RPC_URL") ?? "http://127.0.0.1:28545";
const pub = createPublicClient({ transport: http(RPC) });
const chainId = await pub.getChainId();
const depFile = process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`);
const D = JSON.parse(fs.readFileSync(depFile, "utf8"));
if ((D.ledgerVersion ?? 0) < 3) { console.error("部署檔不是目前版本的帳本（需要 ledgerVersion 3：新台幣入出金版）。請重新部署"); process.exit(1); }
const DATA = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
// 鏈上事件的增量索引（web/data/chain-index），和網站共用
const { deploymentIndex } = await import("../lib/ledger/logindex.ts");
const IDX = deploymentIndex({ dataDir: DATA, chainId, ledger: D.ledger, deployedAt: D.deployedAt, local: chainId === 31337 || chainId === 1337 });
const LEDGER_DIR = process.env.LEDGER_DIR ?? path.join(DATA, "ledger");
const store = openStore(LEDGER_DIR);
const OUT = arg("out") ?? path.join(DATA, "public");
const MIRROR = arg("mirror");

const integrity = store.check();
if (!integrity.ok) { console.error(`✗ 帳本檔案本身不一致：${integrity.problem}`); process.exit(1); }
const events = store.read();
const commitments = await readCommitments(pub, D.ledger, { fromBlock: BigInt(D.deployedAtBlock ?? 0), index: IDX });
console.log(`帳本 ${events.length} 筆；鏈上 ${commitments.length} 期`);

// ── 公開檔 ──
const dir = path.join(OUT, "epochs");
fs.mkdirSync(dir, { recursive: true });
const write = (f, v) => { const tmp = `${f}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v, null, 2)); fs.renameSync(tmp, f); };
let wrote = 0;
for (const [i, c] of commitments.entries()) {
  const f = path.join(dir, `${c.epoch}.json`);
  if (fs.existsSync(f)) continue; // 上鏈的期別不會再變
  const snap = snapshotAt(events, c); // 內含和鏈上 root 的比對
  write(f, publicEpoch({ chainId, ledger: D.ledger, events, commitments, epochIndex: i, snap }));
  wrote += 1;
}
write(path.join(OUT, "index.json"), toJson({
  version: 1, chainId, ledger: D.ledger, settlementToken: D.settlementToken, updatedAt: new Date().toISOString(),
  epochs: commitments.map((c, i) => ({ epoch: c.epoch, anchor: c.anchor, txHash: c.txHash, blockNumber: c.block, firstSeq: i === 0 ? 1n : commitments[i - 1].lastSeq + 1n, lastSeq: c.lastSeq, file: `epochs/${c.epoch}.json` })),
  howToVerify: "每個檔的 leaves 依序號重建事件樹（scheme co2x-keccak-abi-prefixed-v1）應得 manifest.logRoot；registry.leaves 依序重建應得 manifest.registryRoot；兩者都要等於 txHash 那筆 Committed 事件裡的值",
}));
console.log(`公開檔：${OUT}（新寫 ${wrote} 期，共 ${commitments.length} 期）`);

// ── 監理鏡像 ──
if (MIRROR) {
  const m = path.resolve(MIRROR);
  fs.mkdirSync(path.join(m, "ledger"), { recursive: true });
  const files = [];
  const copy = (from, to) => {
    fs.copyFileSync(from, path.join(m, to));
    files.push({ file: to, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(m, to))).digest("hex") });
  };
  // 先複製 head 再複製事件：追加是「先寫事件再改 head」，這個順序複製出來的一定接得上（最多多幾筆 head 還不知道的）
  copy(path.join(LEDGER_DIR, "head.json"), "ledger/head.json");
  copy(path.join(LEDGER_DIR, "events.jsonl"), "ledger/events.jsonl");
  copy(depFile, "deployment.json");
  write(path.join(m, "MANIFEST.json"), toJson({
    version: 1, exportedAt: new Date().toISOString(), chainId, ledger: D.ledger, events: events.length, committedEpochs: commitments.length,
    latest: commitments.at(-1) ? { epoch: commitments.at(-1).epoch, anchor: commitments.at(-1).anchor, txHash: commitments.at(-1).txHash } : null,
    files,
    verify: "LEDGER_DIR=<鏡像>/ledger DEPLOYMENT_FILE=<鏡像>/deployment.json RPC_URL=<任一節點> npm run ledger:verify",
    note: "完整帳本含委託單、身分雜湊與存提紀錄，只交給主管機關與查核機構。身分原文不在帳本裡。",
  }));
  console.log(`監理鏡像：${m}（${events.length} 筆事件、${files.length} 個檔，SHA-256 清單在 MANIFEST.json）`);
}
