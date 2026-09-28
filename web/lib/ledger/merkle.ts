import { encodeAbiParameters, keccak256, type Hex } from "viem";

/// 帳本 v2 共用的 Merkle 樹：事件包含證據（logRoot）、登錄簿（registryRoot）、身分（identityRoot）。
///
/// 規則和餘額樹（lib/ledger/balance-tree.ts）一致，理由也一樣：
///   · 葉子與節點用不同前綴（0x00 / 0x01），防止拿內部節點冒充葉子（second preimage）
///   · 層數不是 2 的冪時，**落單的節點往上帶**，不補假葉子
///   · 節點用 `abi.encode`（不是 packed）：Solidity 那邊驗證時一行 `keccak256(abi.encode(...))` 就對得上
///
/// 這個檔案**不依賴 Next、不用路徑別名**：查核機構要能單獨跑它。

export const ZERO: Hex = `0x${"0".repeat(64)}`;
/// 空樹的 root。刻意不是全零：全零和「欄位沒填」分不出來。
export const EMPTY: Hex = keccak256(encodeAbiParameters([{ type: "bytes1" }, { type: "string" }], ["0x02", "co2x.empty"]));

export const node = (l: Hex, r: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "bytes1" }, { type: "bytes32" }, { type: "bytes32" }], ["0x01", l, r]));

/// 給一個已經算好的葉子內容雜湊，包上葉子前綴。
export const leaf = (contentHash: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "bytes1" }, { type: "bytes32" }], ["0x00", contentHash]));

export type Proof = { siblings: Hex[]; path: bigint };

export type Tree = { root: Hex; size: number; proof: (index: number) => Proof };

export function buildTree(leaves: Hex[]): Tree {
  if (leaves.length === 0) return { root: EMPTY, size: 0, proof: () => { throw new Error("空樹沒有證據"); } };
  const layers: Hex[][] = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? node(cur[i], cur[i + 1]) : cur[i]);
    layers.push(next);
    cur = next;
  }
  return {
    root: cur[0],
    size: leaves.length,
    proof: (index) => {
      if (index < 0 || index >= leaves.length) throw new Error(`葉子 ${index} 不在樹裡`);
      const siblings: Hex[] = [];
      let path = 0n;
      let idx = index;
      for (let level = 0; level < layers.length - 1; level++) {
        const layer = layers[level];
        const isRight = idx % 2 === 1;
        const sib = isRight ? idx - 1 : idx + 1;
        if (sib < layer.length) {
          if (isRight) path |= 1n << BigInt(siblings.length);
          siblings.push(layer[sib]);
        }
        idx = Math.floor(idx / 2);
      }
      return { siblings, path };
    },
  };
}

/// 用證據算回 root。path 的第 i 位是 1 代表第 i 個兄弟在左邊。
export function rootFrom(leafHash: Hex, p: Proof): Hex {
  let h = leafHash;
  p.siblings.forEach((s, i) => {
    h = (p.path >> BigInt(i)) & 1n ? node(s, h) : node(h, s);
  });
  return h;
}
