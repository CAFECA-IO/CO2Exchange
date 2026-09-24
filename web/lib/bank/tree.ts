import { encodePacked, keccak256, type Address, type Hex } from "viem";

/// 餘額樹：帶總額的 Merkle 樹（Merkle Sum Tree）。
///
/// 這個檔案**刻意不加 `server-only`**：它是純計算，沒有秘密，而且使用者應該要能
/// 在自己的瀏覽器裡驗證自己那份證據——「你不必相信我們」這句話要成立，
/// 驗證的程式碼就得跑得到使用者手上。
///
/// **這個檔案必須和 `src/bank/MerkleSumTree.sol` 逐位元組一致。**
/// 不一致的後果不是「測試紅一條」，是使用者拿著正確的餘額卻領不到錢——
/// 而且要等到有人真的去提領才會發現。所以有一支跨語言一致性測試
/// （`test/BankTree.t.sol` 讀 `web/scripts/gen-tree-fixture.mjs` 產生的 fixture），
/// 改動任何一邊的雜湊格式，那支測試會立刻紅。
///
/// 為什麼要帶總額，見 MerkleSumTree.sol 的註解：簡單說，普通 Merkle 樹擋不住
/// 「把某些使用者排除在樹外」，而那正是交易所隱藏資不抵債的標準手法。

const LEAF = "0x00";
const NODE = "0x01";

export type AssetBalance = { batchId: bigint; kg: bigint };

export type AccountBalance = {
  account: Address;
  /// 逐批次持有。順序不重要，這裡會自己依 batchId 排序——
  /// 排序規則是樹的一部分，交給呼叫端決定的話兩邊會算出不同的 root。
  assets: AssetBalance[];
  cash: bigint;
};

export type Node = { hash: Hex; kg: bigint; cash: bigint };

const leafHash = (account: Address, epoch: bigint, assetsRoot: Hex, kg: bigint, cash: bigint): Hex =>
  keccak256(
    encodePacked(
      ["bytes1", "address", "uint64", "bytes32", "uint256", "uint256"],
      [LEAF, account, epoch, assetsRoot, kg, cash],
    ),
  );

const nodeHash = (l: Node, r: Node): Hex =>
  keccak256(
    encodePacked(
      ["bytes1", "bytes32", "uint256", "uint256", "bytes32", "uint256", "uint256"],
      [NODE, l.hash, l.kg, l.cash, r.hash, r.kg, r.cash],
    ),
  );

const parent = (l: Node, r: Node): Node => ({ hash: nodeHash(l, r), kg: l.kg + r.kg, cash: l.cash + r.cash });

export const assetLeafHash = (batchId: bigint, kg: bigint): Hex =>
  keccak256(encodePacked(["bytes1", "uint256", "uint256"], [LEAF, batchId, kg]));

const assetNodeHash = (l: Hex, r: Hex): Hex => keccak256(encodePacked(["bytes1", "bytes32", "bytes32"], [NODE, l, r]));

/// 空的資產樹。帳戶只有現金、沒有任何碳權時用得到。
export const EMPTY_ROOT: Hex = keccak256(encodePacked(["bytes1"], ["0x02"]));

/// ── 樹的形狀 ──
///
/// 層數不是 2 的冪時，**把落單的節點往上帶**（不補假葉子）。
/// 補假葉子的做法要定義「假葉子長什麼樣」，而那個定義一旦和 Solidity 那邊不一致
/// 就是一個提領漏洞；往上帶沒有這個問題，代價只是樹不平衡，深度差一層。
function build<T>(leaves: T[], combine: (l: T, r: T) => T): { root: T; layers: T[][] } {
  if (leaves.length === 0) throw new Error("空的樹沒有 root，呼叫端要自己處理這個情況");
  const layers: T[][] = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next: T[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? combine(cur[i], cur[i + 1]) : cur[i]);
    }
    layers.push(next);
    cur = next;
  }
  return { root: cur[0], layers };
}

/// 從 layers 取一片葉子的證據。回傳兄弟節點與位元圖（1 = 兄弟在左邊）。
function proofOf<T>(layers: T[][], index: number): { siblings: T[]; path: bigint } {
  const siblings: T[] = [];
  let path = 0n;
  let idx = index;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    if (siblingIdx < layer.length) {
      siblings.push(layer[siblingIdx]);
      if (isRight) path |= 1n << BigInt(siblings.length - 1);
    }
    // 落單往上帶的那一層沒有兄弟，也就不佔一個 path 位元
    idx = Math.floor(idx / 2);
  }
  return { siblings, path };
}

export type AssetTree = { root: Hex; totalKg: bigint; proof: (batchId: bigint) => { kg: bigint; siblings: Hex[]; path: bigint } };

export function buildAssetTree(assets: AssetBalance[]): AssetTree {
  const sorted = [...assets].filter((a) => a.kg > 0n).sort((a, b) => (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0));
  const totalKg = sorted.reduce((s, a) => s + a.kg, 0n);
  if (sorted.length === 0) {
    return {
      root: EMPTY_ROOT,
      totalKg: 0n,
      proof: () => { throw new Error("這個帳戶沒有任何碳權"); },
    };
  }
  const leaves = sorted.map((a) => assetLeafHash(a.batchId, a.kg));
  const { root, layers } = build(leaves, assetNodeHash);
  return {
    root,
    totalKg,
    proof: (batchId: bigint) => {
      const i = sorted.findIndex((a) => a.batchId === batchId);
      if (i < 0) throw new Error(`這個帳戶沒有批次 ${batchId}`);
      return { kg: sorted[i].kg, ...proofOf(layers, i) };
    },
  };
}

export type BalanceProof = {
  epoch: bigint;
  account: Address;
  assetsRoot: Hex;
  leafKg: bigint;
  leafCash: bigint;
  siblings: Node[];
  path: bigint;
};

export type BalanceTree = {
  root: Node;
  epoch: bigint;
  /// 逐批次的總額明細。公開檔，讓任何人都能拿去和 Bank 的鏈上持有量逐批對照。
  totalsByBatch: { batchId: bigint; kg: bigint }[];
  proofOf: (account: Address) => BalanceProof;
  assetProofOf: (account: Address, batchId: bigint) => { kg: bigint; siblings: Hex[]; path: bigint };
};

export function buildBalanceTree(balances: AccountBalance[], epoch: bigint): BalanceTree {
  // 依帳戶地址排序。和資產樹同樣的理由：排序規則是樹的一部分。
  const sorted = [...balances].sort((a, b) => (a.account.toLowerCase() < b.account.toLowerCase() ? -1 : 1));
  if (sorted.some((b) => b.cash < 0n || b.assets.some((a) => a.kg < 0n))) {
    // 負數餘額會讓「總額」這件事整個失去意義（可以用負的葉子把總數壓低），
    // 所以在這裡擋，而不是相信上游。
    throw new Error("餘額不得為負");
  }

  const assetTrees = new Map<string, AssetTree>();
  const leaves: Node[] = sorted.map((b) => {
    const t = buildAssetTree(b.assets);
    assetTrees.set(b.account.toLowerCase(), t);
    return { hash: leafHash(b.account, epoch, t.root, t.totalKg, b.cash), kg: t.totalKg, cash: b.cash };
  });

  const totals = new Map<bigint, bigint>();
  for (const b of sorted) for (const a of b.assets) if (a.kg > 0n) totals.set(a.batchId, (totals.get(a.batchId) ?? 0n) + a.kg);

  if (leaves.length === 0) {
    throw new Error("沒有任何帳戶，這個 epoch 不需要提交");
  }
  const { root, layers } = build(leaves, parent);

  const indexOf = (account: Address) => {
    const i = sorted.findIndex((b) => b.account.toLowerCase() === account.toLowerCase());
    if (i < 0) throw new Error(`${account} 不在這一期的餘額樹裡`);
    return i;
  };

  return {
    root,
    epoch,
    totalsByBatch: [...totals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([batchId, kg]) => ({ batchId, kg })),
    proofOf: (account) => {
      const i = indexOf(account);
      const t = assetTrees.get(sorted[i].account.toLowerCase())!;
      return {
        epoch, account: sorted[i].account, assetsRoot: t.root,
        leafKg: t.totalKg, leafCash: sorted[i].cash, ...proofOf(layers, i),
      };
    },
    assetProofOf: (account, batchId) => {
      const i = indexOf(account);
      return assetTrees.get(sorted[i].account.toLowerCase())!.proof(batchId);
    },
  };
}

/// 逐批次明細表的 hash，進 `commit` 的 `totalsHash`。
/// 表本身是公開檔——它不洩漏任何個別持有人的資訊，卻讓償付能力變成人人可查。
export const totalsHashOf = (totals: { batchId: bigint; kg: bigint }[], totalCash: bigint): Hex =>
  keccak256(
    encodePacked(
      ["uint256[]", "uint256[]", "uint256"],
      [totals.map((t) => t.batchId), totals.map((t) => t.kg), totalCash],
    ),
  );
