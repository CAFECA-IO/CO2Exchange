#!/usr/bin/env node
// 承諾排程有沒有在跑（判斷規則見 lib/ledger/liveness.ts）。給 cron、demo-box、外部監控用。
//
//   npm run ledger:health              # 印一行狀態；exit 0 正常、1 落後、2 停擺、3 讀不到鏈或部署檔
//   npm run ledger:health -- --json    # 整份結果（JSON）
//
// 門檻：COMMIT_LATE_AFTER（預設 7200 秒）、COMMIT_STALLED_AFTER（預設 21600 秒）、
// HEARTBEAT_AFTER（預設 86400 秒，要與提交程式的同一個值）。
//
// 不經過網站：網站掛了這支照樣答得出來（它讀的是帳本檔與鏈），反過來也一樣——
// 網站的 /api/health 是同一套判斷。
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { setting } from "./lib/keys.mjs";

const { openStore } = await import("../lib/ledger/store.ts");
const { readCommitments, LEDGER_ABI } = await import("../lib/ledger/chain.ts");
const { deploymentIndex } = await import("../lib/ledger/logindex.ts");
const { assessLiveness, thresholdsFromEnv } = await import("../lib/ledger/liveness.ts");

const JSON_OUT = process.argv.includes("--json");
const out = (code, line, obj) => {
  if (JSON_OUT) console.log(JSON.stringify(obj ?? { error: line }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  else console.log(line);
  process.exit(code);
};

try {
  const RPC = setting("RPC_URL") ?? "http://127.0.0.1:28545";
  const pub = createPublicClient({ transport: http(RPC) });
  const chainId = await pub.getChainId();
  const LOCAL = chainId === 31337 || chainId === 1337;
  const D = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT_FILE ?? path.resolve(process.cwd(), "..", "deployments", `${chainId}.json`), "utf8"));
  const DATA = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
  const index = deploymentIndex({ dataDir: DATA, chainId, ledger: D.ledger, deployedAt: D.deployedAt, local: LOCAL });
  const store = openStore(process.env.LEDGER_DIR ?? path.join(DATA, "ledger"));
  const [committed, [, , latestEpoch, committedAt], block] = await Promise.all([
    readCommitments(pub, D.ledger, { fromBlock: BigInt(D.deployedAtBlock ?? 0), index }),
    pub.readContract({ address: D.ledger, abi: LEDGER_ABI, functionName: "solvency" }),
    pub.getBlock({ blockTag: "latest" }),
  ]);
  const l = assessLiveness({
    wallClock: Math.floor(Date.now() / 1000),
    chainTime: Number(block.timestamp),
    events: store.read(),
    lastEpoch: latestEpoch > 0n ? Number(latestEpoch) : null,
    committedSeq: Number(committed.at(-1)?.lastSeq ?? 0n),
    lastCommittedAt: latestEpoch > 0n ? Number(committedAt) : null,
    thresholds: thresholdsFromEnv(),
  });
  const mark = { ok: "✓", empty: "·", late: "!", stalled: "✗" }[l.status];
  out({ ok: 0, empty: 0, late: 1, stalled: 2 }[l.status], `${mark} ${l.reason}`, l);
} catch (e) {
  out(3, `✗ 讀不到帳本或鏈：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
}
