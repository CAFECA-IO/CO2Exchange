import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { buildBalanceTree, totalsHashOf, type BalanceTree } from "../bank/tree.ts";
import { balancesOf, type Batch, type Certificate, type Identity, type Jurisdiction, type Project, type ReserveReport, type State } from "./engine.ts";
import { countryToBytes2 } from "./events.ts";
import { buildTree, EMPTY, leaf, type Proof } from "./merkle.ts";

/// 狀態 → 每一期承諾裡的四個 root 與兩個總額。
///
/// **這些葉子的格式與 Solidity 那邊必須逐位元組一致**（帳本合約要能驗 `registryRoot` 裡的批次、
/// `balanceRoot` 裡的持有，逃生門的請求權登記靠它）。所以一律用 `abi.encode`，前面帶型別標籤，
/// 字串欄位先各自雜湊——合約那邊只需要 `keccak256(abi.encode(...))` 一行。

export const TAG = { jurisdiction: 1, project: 2, batch: 3, certificate: 4, report: 5, policy: 6, fee: 7 } as const;
const h = (s: string): Hex => keccak256(new TextEncoder().encode(s));
const E = (types: string[], values: unknown[]) => keccak256(encodeAbiParameters(types.map((type) => ({ type })), values as never));

export const jurisdictionContent = (j: Jurisdiction) => E(
  ["uint8", "bytes2", "bool", "bool", "uint8", "bytes32", "bytes32", "bytes32", "bytes32"],
  [TAG.jurisdiction, countryToBytes2(j.country), j.enabled, j.domestic, j.purposeMask, h(j.name), h(j.scheme), h(j.registryName), h(j.note)],
);
export const projectContent = (p: Project) => E(
  ["uint8", "uint256", "address", "bytes32", "bytes32", "bytes32", "bytes32", "bool", "bytes2", "bytes32"],
  [TAG.project, p.id, p.owner, h(p.name), h(p.methodology), h(p.location), h(p.metadataURI), p.active, countryToBytes2(p.country), h(p.scheme)],
);
/// 批次葉子。**帳本合約的 `claimCredits` 會驗這一片**，欄位順序不能動。
export const batchContent = (b: Batch) => E(
  ["uint8", "uint256", "uint256", "uint64", "uint64", "uint16", "bytes32", "bytes32", "address", "uint64", "uint256", "uint256", "bool"],
  [TAG.batch, b.id, b.projectId, b.monitoringStart, b.monitoringEnd, b.vintageYear, b.serialHash, b.reportHash, b.verifier, b.issuedAt, b.issuedKg, b.retiredKg, b.frozen],
);
export const certificateContent = (c: Certificate) => E(
  ["uint8", "uint256", "uint256", "address", "uint256", "bytes32", "bytes32", "uint8", "bytes32", "uint64", "bytes2", "bytes32", "uint256", "uint64", "bytes32", "bytes32", "uint64"],
  [TAG.certificate, c.id, c.batchId, c.account, c.amountKg, h(c.beneficiary), c.beneficiaryHash, c.purpose, h(c.memo), c.retiredAt,
    countryToBytes2(c.country), h(c.scheme), c.fee, c.atSeq, c.documentHash ?? `0x${"0".repeat(64)}`, h(c.officialRef), c.officialAt],
);
export const reportContent = (r: ReserveReport) => E(
  ["uint8", "uint256", "uint32", "uint64", "bytes32", "bytes32", "address", "uint64", "uint8", "address", "bytes32", "bytes32"],
  [TAG.report, r.id, r.period, r.asOf, r.contentHash, r.documentHash, r.publisher, r.publishedAt, r.status, r.auditor, h(r.auditorName), h(r.note)],
);
export const policyContent = (s: State) => E(
  ["uint8", "bool", "bool", "address", "uint256", "uint256"],
  [TAG.policy, s.policy.individualTransfer, s.policy.individualRetire, s.policy.treasury, s.fees.tradeBps, s.fees.retireFeePerTonne],
);
export const feeContent = (country: string, f: { tradeBps: bigint; retireFeePerTonne: bigint }) => E(
  ["uint8", "bytes2", "uint256", "uint256"], [TAG.fee, countryToBytes2(country), f.tradeBps, f.retireFeePerTonne],
);
export const identityContent = (i: Identity) => E(
  ["address", "uint8", "uint64", "bytes2", "bytes32", "bool"],
  [i.account, i.tier, i.expiry, countryToBytes2(i.jurisdiction), i.identityHash, i.frozen],
);

type RegistryKey = { tag: number; id: string };
const cmpBig = (a: string, b: string) => { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; };

/// 登錄簿樹：依（標籤, 編號）排序。轄區以代碼字串排序、費率以國別排序。
export function registryTree(s: State) {
  const entries: { key: RegistryKey; content: Hex }[] = [];
  for (const j of [...s.jurisdictions.values()].sort((a, b) => (a.country < b.country ? -1 : 1))) entries.push({ key: { tag: TAG.jurisdiction, id: j.country }, content: jurisdictionContent(j) });
  for (const p of [...s.projects.values()].sort((a, b) => cmpBig(String(a.id), String(b.id)))) entries.push({ key: { tag: TAG.project, id: String(p.id) }, content: projectContent(p) });
  for (const b of [...s.batches.values()].sort((a, b) => cmpBig(String(a.id), String(b.id)))) entries.push({ key: { tag: TAG.batch, id: String(b.id) }, content: batchContent(b) });
  for (const c of [...s.certificates.values()].sort((a, b) => cmpBig(String(a.id), String(b.id)))) entries.push({ key: { tag: TAG.certificate, id: String(c.id) }, content: certificateContent(c) });
  for (const r of [...s.reports.values()].sort((a, b) => cmpBig(String(a.id), String(b.id)))) entries.push({ key: { tag: TAG.report, id: String(r.id) }, content: reportContent(r) });
  entries.push({ key: { tag: TAG.policy, id: "0" }, content: policyContent(s) });
  for (const [c, f] of [...s.fees.byCountry.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) entries.push({ key: { tag: TAG.fee, id: c }, content: feeContent(c, f) });

  const t = buildTree(entries.map((x) => leaf(x.content)));
  return {
    root: t.root,
    size: t.size,
    proofOf: (tag: number, id: string | bigint): Proof & { content: Hex } => {
      const i = entries.findIndex((x) => x.key.tag === tag && x.key.id === String(id));
      if (i < 0) throw new Error(`登錄簿裡沒有 (${tag}, ${id})`);
      return { ...t.proof(i), content: entries[i].content };
    },
  };
}

/// 身分樹：依帳戶地址排序。葉子只有 identityHash，沒有任何原文。
export function identityTree(s: State) {
  const ids = [...s.identities.values()].sort((a, b) => (a.account.toLowerCase() < b.account.toLowerCase() ? -1 : 1));
  const t = buildTree(ids.map((i) => leaf(identityContent(i))));
  return {
    root: t.root,
    proofOf: (account: Address): Proof & { content: Hex } => {
      const i = ids.findIndex((x) => x.account.toLowerCase() === account.toLowerCase());
      if (i < 0) throw new Error(`${account} 沒有身分紀錄`);
      return { ...t.proof(i), content: identityContent(ids[i]) };
    },
  };
}

export type Roots = {
  balanceRoot: Hex; registryRoot: Hex; identityRoot: Hex;
  totalKg: bigint; totalCash: bigint; totalsHash: Hex;
  balanceTree: BalanceTree | null;
  registry: ReturnType<typeof registryTree>;
  identity: ReturnType<typeof identityTree>;
};

/// 一個狀態的全部承諾值。`epoch` 進餘額樹的葉子（防止拿舊一期的證據重放）。
export function rootsOf(s: State, epoch: bigint): Roots {
  const balances = balancesOf(s);
  const balanceTree = balances.length ? buildBalanceTree(balances, epoch) : null;
  const totals = balanceTree?.totalsByBatch ?? [];
  const totalCash = balanceTree?.root.cash ?? 0n;
  const registry = registryTree(s);
  const identity = identityTree(s);
  return {
    balanceRoot: balanceTree?.root.hash ?? EMPTY,
    registryRoot: registry.root,
    identityRoot: identity.root,
    totalKg: balanceTree?.root.kg ?? 0n,
    totalCash,
    totalsHash: totalsHashOf(totals, totalCash),
    balanceTree, registry, identity,
  };
}

/// 一期的 anchor。**帳本合約用同一個公式**；改這裡就要改合約，而且之前所有 anchor 都要重算。
export function anchorOf(a: {
  prev: Hex; epoch: bigint; logRoot: Hex; balanceRoot: Hex; registryRoot: Hex; identityRoot: Hex;
  totalKg: bigint; totalCash: bigint; totalsHash: Hex; upToBlock: bigint; lastSeq: bigint; rulesVersion: number;
}): Hex {
  return keccak256(encodeAbiParameters(
    ["bytes32", "uint64", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint256", "bytes32", "uint64", "uint64", "uint16"].map((type) => ({ type })),
    [a.prev, a.epoch, a.logRoot, a.balanceRoot, a.registryRoot, a.identityRoot, a.totalKg, a.totalCash, a.totalsHash, a.upToBlock, a.lastSeq, a.rulesVersion] as never,
  ));
}
