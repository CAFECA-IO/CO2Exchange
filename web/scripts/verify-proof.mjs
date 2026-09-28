#!/usr/bin/env node
// 驗證使用者的證明檔（設計 v4 第 6 期）——**不需要交易所的任何程式或資料**，只要證明檔與一個節點。
//
//   node scripts/verify-proof.mjs my-proof.json [--rpc http://211.22.118.149:8545] [--out report.json]
//
// 這支刻意只用 viem、不 import 交易所的帳本程式碼：它是證明檔格式（Boltchain Issue #1）的參考實作，
// 驗的規則全部來自證明檔裡宣告的 scheme（見 docs/proof-schemes.md）。Explorer 照這支做就能驗。
//
// 每一項證據：
//   1. 回鏈上找 anchor 指的那筆交易、那個 log，確認是那份合約發出的 Committed 事件，取出 field 那個 root
//   2. 從證明檔裡的**原像**（ABI 型別與值、或整段編碼）自己算葉子，依 scheme 與 siblings／path 算回 root
//   3. 兩者相等才算通過；託管證據另外比對 root 的兩個總額，並列出帳本合約現在記帳的 TWD
//      （規則第 4 版：真的新台幣在信託專戶；鏈上的 TWD 只存在帳本合約裡、不能轉出，總量＝營運方宣稱的專戶餘額）
//
// 報告（--out）只含雜湊與鏈上原始資料，不含證明檔的內容，任何人拿報告都能對任一節點重做一次。
import fs from "node:fs";
import crypto from "node:crypto";
import { createPublicClient, decodeEventLog, encodeAbiParameters, encodePacked, http, keccak256, parseAbi } from "viem";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const flag = (n) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : undefined; };
if (!file) { console.error("用法：node scripts/verify-proof.mjs <證明檔.json> [--rpc URL] [--out 報告.json]"); process.exit(2); }
const raw = fs.readFileSync(file);
const P = JSON.parse(raw.toString("utf8"));
const RPC = flag("rpc") ?? process.env.RPC_URL ?? "http://211.22.118.149:8545";
const client = createPublicClient({ transport: http(RPC) });

const B = (x) => BigInt(x);
const COMMITTED = parseAbi([
  "struct CommitInput { bytes32 prev; uint64 epoch; bytes32 logRoot; bytes32 balanceRoot; bytes32 registryRoot; bytes32 identityRoot; uint256 totalKg; uint256 totalCash; bytes32 totalsHash; uint64 upToBlock; uint64 lastSeq; uint16 rulesVersion; }",
  "event Committed(uint64 indexed epoch, bytes32 anchor, CommitInput commitment)",
]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);

// ── 三種 scheme（和 docs/proof-schemes.md 逐字相同）──
const abiEnc = (types, values) => encodeAbiParameters(types.map((type) => ({ type })), values);
const inclusion = {
  leaf: (contentHash) => keccak256(abiEnc(["bytes1", "bytes32"], ["0x00", contentHash])),
  node: (l, r) => keccak256(abiEnc(["bytes1", "bytes32", "bytes32"], ["0x01", l, r])),
};
function up(leafHash, siblings, path, node) {
  let h = leafHash;
  siblings.forEach((s, i) => { h = (B(path) >> BigInt(i)) & 1n ? node(s, h) : node(h, s); });
  return h;
}
const sumLeaf = (l) => ({
  hash: keccak256(encodePacked(["bytes1", "address", "uint64", "bytes32", "uint256", "uint256", "uint256", "uint256"],
    ["0x00", l.account, B(l.epoch), l.assetsRoot, B(l.kg), B(l.cash), B(l.requested), B(l.settled)])),
  kg: B(l.kg), cash: B(l.cash),
});
const sumNode = (a, b) => ({
  hash: keccak256(encodePacked(["bytes1", "bytes32", "uint256", "uint256", "bytes32", "uint256", "uint256"], ["0x01", a.hash, a.kg, a.cash, b.hash, b.kg, b.cash])),
  kg: a.kg + b.kg, cash: a.cash + b.cash,
});
const assetLeaf = (batchId, kg) => keccak256(encodePacked(["bytes1", "uint256", "uint256"], ["0x00", B(batchId), B(kg)]));
const assetNode = (l, r) => keccak256(encodePacked(["bytes1", "bytes32", "bytes32"], ["0x01", l, r]));

// ABI 值：JSON 裡的整數是十進位字串，uint* 要轉回 bigint
const typed = (types, values) => values.map((v, i) => (/^u?int/.test(types[i]) ? B(v) : v));

// ── 鏈上的 anchor ──
const anchors = new Map();
async function anchorRoot(a) {
  const key = `${a.txHash}:${a.logIndex}`;
  if (!anchors.has(key)) {
    const rc = await client.getTransactionReceipt({ hash: a.txHash });
    const log = rc.logs.find((l) => Number(l.logIndex) === Number(a.logIndex));
    if (!log) throw new Error(`交易 ${a.txHash} 沒有第 ${a.logIndex} 個 log`);
    if (log.address.toLowerCase() !== a.contract.toLowerCase()) throw new Error(`那個 log 不是 ${a.contract} 發出的`);
    const ev = decodeEventLog({ abi: COMMITTED, data: log.data, topics: log.topics });
    const block = await client.getBlock({ blockNumber: rc.blockNumber });
    anchors.set(key, { commitment: ev.args.commitment, anchor: ev.args.anchor, blockNumber: rc.blockNumber, blockHash: rc.blockHash, timestamp: block.timestamp, logData: log.data, topics: log.topics });
  }
  const got = anchors.get(key);
  const field = a.field.replace(/^commitment\./, "");
  return { ...got, root: got.commitment[field] };
}

// ── 逐項驗證 ──
const results = [];
let custodyAssetsRoot = null;
for (const [i, p] of (P.proofs ?? []).entries()) {
  const r = { index: i, type: p.type, ok: false };
  try {
    if (p.type === "custody") {
      if (p.scheme !== "co2x-merkle-sum-v2") throw new Error(`不認得的 scheme ${p.scheme}`);
      const on = await anchorRoot(p.anchor);
      let n = sumLeaf(p.leaf);
      p.siblings.forEach((s, k) => {
        const sib = { hash: s.hash, kg: B(s.kg), cash: B(s.cash) };
        n = (B(p.path) >> BigInt(k)) & 1n ? sumNode(sib, n) : sumNode(n, sib);
      });
      const [held, supply] = await Promise.all([
        client.readContract({ address: p.custody.token, abi: ERC20, functionName: "balanceOf", args: [p.custody.holder] }),
        client.readContract({ address: p.custody.token, abi: ERC20, functionName: "totalSupply" }),
      ]);
      r.ok = n.hash === on.root && n.kg === on.commitment.totalKg && n.cash === on.commitment.totalCash
        && p.leaf.account.toLowerCase() === P.account.toLowerCase() && B(p.leaf.epoch) === on.commitment.epoch;
      r.detail = {
        epoch: String(on.commitment.epoch), root: on.root, computed: n.hash,
        totals: { kg: String(n.kg), cash: String(n.cash), committedKg: String(on.commitment.totalKg), committedCash: String(on.commitment.totalCash) },
        yourLeaf: { kg: String(p.leaf.kg), cash: String(p.leaf.cash), requested: String(p.leaf.requested), settled: String(p.leaf.settled) },
        custodyHeldNow: String(held), tokenSupply: String(supply), onlyInLedger: held === supply, solvent: held >= on.commitment.totalCash,
      };
      custodyAssetsRoot = p.leaf.assetsRoot;
    } else if (p.type === "credit") {
      const a = up(assetLeaf(p.holding.leaf.batchId, p.holding.leaf.kg), p.holding.siblings, p.holding.path, assetNode);
      const on = await anchorRoot(p.registry.anchor);
      const content = keccak256(abiEnc(p.registry.content.types, typed(p.registry.content.types, p.registry.content.values)));
      const reg = up(inclusion.leaf(content), p.registry.siblings, p.registry.path, inclusion.node);
      r.ok = a === p.holding.root && (custodyAssetsRoot === null || a === custodyAssetsRoot) && reg === on.root;
      r.detail = { batchId: String(p.batchId), kg: String(p.holding.leaf.kg), assetsRoot: a, registryRoot: on.root, computedRegistry: reg };
    } else if (p.type === "identity" || p.type === "event") {
      const on = await anchorRoot(p.anchor);
      let content;
      if (p.type === "event") {
        content = keccak256(p.encoded);
        if (content !== p.contentHash) throw new Error("encoded 的雜湊和 contentHash 不同");
      } else content = keccak256(abiEnc(p.content.types, typed(p.content.types, p.content.values)));
      const root = up(inclusion.leaf(content), p.siblings, p.path, inclusion.node);
      r.ok = root === on.root;
      r.detail = { epoch: String(on.commitment.epoch), field: p.anchor.field, root: on.root, computed: root, ...(p.type === "event" ? { seq: String(p.seq), kind: p.kind } : {}) };
    } else throw new Error(`不認得的證據種類 ${p.type}`);
  } catch (e) { r.error = e instanceof Error ? e.message : String(e); }
  r.anchor = p.anchor ?? p.registry?.anchor;
  results.push(r);
}

// ── 輸出 ──
const ok = results.length > 0 && results.every((r) => r.ok);
const label = { custody: "託管（持有）", credit: "碳權批次", identity: "身分", event: "事件" };
for (const r of results) {
  const d = r.detail ?? {};
  const extra = r.type === "custody" ? `第 ${d.epoch} 期；碳權 ${d.yourLeaf?.kg} kg、新台幣 ${d.yourLeaf?.cash}（最小單位）；帳本合約記帳的 TWD ${d.custodyHeldNow}（${d.solvent ? "不少於承諾總額" : "⚠️ 少於承諾總額"}${d.onlyInLedger === false ? "；⚠️ 有 TWD 不在帳本合約裡" : ""}）`
    : r.type === "credit" ? `批次 #${d.batchId} ${d.kg} kg` : r.type === "event" ? `第 ${d.seq} 筆 ${d.kind}（第 ${d.epoch} 期）` : r.type === "identity" ? `第 ${d.epoch} 期` : "";
  console.log(`${r.ok ? "✓" : "✗"} ${label[r.type] ?? r.type}　${extra}${r.error ? `　${r.error}` : ""}`);
}
console.log(`\n${ok ? "全部符合鏈上的證據" : "有證據不符合，見上面標 ✗ 的項目"}（${results.filter((r) => r.ok).length}/${results.length}）`);

const out = flag("out");
if (out) {
  const report = {
    version: 1, verifiedAt: new Date().toISOString(), rpc: RPC.replace(/\/\/[^@]*@/, "//"), chainId: await client.getChainId(),
    file: { sha256: crypto.createHash("sha256").update(raw).digest("hex"), keccak256: keccak256(raw) },
    account: P.account, result: ok ? "match" : "mismatch",
    anchors: [...anchors.entries()].map(([k, v]) => ({ ref: k, blockNumber: String(v.blockNumber), blockHash: v.blockHash, timestamp: String(v.timestamp), anchor: v.anchor, topics: v.topics, data: v.logData })),
    results: results.map(({ index, type, ok: good, error, detail, anchor }) => ({ index, type, ok: good, error, detail, anchor })),
  };
  fs.writeFileSync(out, JSON.stringify(report, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
  console.log(`報告：${out}（不含證明檔內容，只有雜湊與鏈上原始資料）`);
}
process.exit(ok ? 0 : 1);
