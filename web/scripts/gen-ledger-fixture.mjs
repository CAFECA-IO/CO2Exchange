#!/usr/bin/env node
// 產生帳本 v2 的跨語言 fixture（test/fixtures/ledger.json），給 test/LedgerFixture.t.sol 讀。
//
//   cd web && npm run gen:ledger-fixture
//
// 帳本有兩份實作：TypeScript 建樹、算 anchor、出證據；Solidity 驗 anchor 與逃生門的證據。
// 兩邊必須逐位元組一致——不一致的後果是：使用者拿著完全正確的證據卻登記不了請求權、
// 或者合約接受了一個重播算不出來的承諾。所以用同一份測試情境（lib/ledger-scenario.mjs）
// 在這邊算、在那邊驗。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildScenario } from "./lib/ledger-scenario.mjs";

const { replay } = await import("../lib/ledger/replay.ts");
const { rootsOf, TAG } = await import("../lib/ledger/trees.ts");

const { events, domains, authorities, actors } = await buildScenario();
const boundaries = [{ epoch: 1n, lastSeq: 12n, upToBlock: 112n }, { epoch: 2n, lastSeq: BigInt(events.length), upToBlock: 700n }];
const r = await replay(events, { domains, authorities, boundaries });
const roots = rootsOf(r.state, 2n);

const who = actors.Y.address;
const bp = roots.balanceTree.proofOf(who);
const batchId = 1n;
const ap = roots.balanceTree.assetProofOf(who, batchId);
const rp = roots.registry.proofOf(TAG.batch, batchId);
const b = r.state.batches.get(String(batchId));

const s = (x) => (typeof x === "bigint" ? x.toString() : x);
const out = {
  note: "由 web/scripts/gen-ledger-fixture.mjs 產生，不要手改",
  epochs: r.epochs.map((e) => ({
    prev: e.prev, epoch: s(e.epoch), logRoot: e.logRoot, balanceRoot: e.roots.balanceRoot, registryRoot: e.roots.registryRoot,
    identityRoot: e.roots.identityRoot, totalKg: s(e.roots.totalKg), totalCash: s(e.roots.totalCash), totalsHash: e.roots.totalsHash,
    upToBlock: s(e.upToBlock), lastSeq: s(e.lastSeq), rulesVersion: e.rulesVersion, anchor: e.anchor,
  })),
  claim: {
    account: who, proofEpoch: "2", assetsRoot: bp.assetsRoot, leafKg: s(bp.leafKg), leafCash: s(bp.leafCash),
    leafRequested: s(bp.leafRequested), leafSettled: s(bp.leafSettled),
    siblingHashes: bp.siblings.map((x) => x.hash), siblingKgs: bp.siblings.map((x) => s(x.kg)), siblingCashes: bp.siblings.map((x) => s(x.cash)),
    path: s(bp.path),
    batchKg: s(ap.kg), assetSiblings: ap.siblings, assetPath: s(ap.path),
    batch: {
      id: s(b.id), projectId: s(b.projectId), monitoringStart: s(b.monitoringStart), monitoringEnd: s(b.monitoringEnd),
      vintageYear: b.vintageYear, serialHash: b.serialHash, reportHash: b.reportHash, verifier: b.verifier,
      issuedAt: s(b.issuedAt), issuedKg: s(b.issuedKg), retiredKg: s(b.retiredKg), frozen: b.frozen,
    },
    registrySiblings: rp.siblings, registryPath: s(rp.path),
  },
};
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "ledger.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`已寫出 ${path.relative(process.cwd(), file)}：${out.epochs.length} 期、請求權證據（${who.slice(0, 10)}… 批次 ${batchId}，${ap.kg} kg）`);
