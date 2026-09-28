// 伺服器端只需要的最小 ABI 子集。帳本合約的 ABI 在 lib/ledger/chain.ts（LEDGER_ABI）。

/// 記帳 TWD（LedgerTWD）：只讀。它只存在帳本合約裡、不能轉出，鑄造與銷毀只有帳本合約做得到。
export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const accessControlAbi = [
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;

export const safeViewAbi = [
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const timelockAbi = [
  { type: "function", name: "getMinDelay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getOperationState", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "getTimestamp", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "event", name: "CallScheduled", inputs: [
    { name: "id", type: "bytes32", indexed: true }, { name: "index", type: "uint256", indexed: true }, { name: "target", type: "address", indexed: false },
    { name: "value", type: "uint256", indexed: false }, { name: "data", type: "bytes", indexed: false }, { name: "predecessor", type: "bytes32", indexed: false },
    { name: "delay", type: "uint256", indexed: false } ] },
] as const;
