// 前端只需要的最小 ABI 子集（與 Solidity 介面一致）

export const kycRegistryAbi = [
  {
    type: "function", name: "identityOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "tuple", components: [
      { name: "tier", type: "uint8" }, { name: "expiry", type: "uint64" }, { name: "frozen", type: "bool" },
      { name: "jurisdiction", type: "bytes2" }, { name: "identityHash", type: "bytes32" } ] }],
  },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isActive", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "register", stateMutability: "nonpayable",
    inputs: [
      { name: "a", type: "tuple", components: [
        { name: "account", type: "address" }, { name: "tier", type: "uint8" }, { name: "expiry", type: "uint64" },
        { name: "jurisdiction", type: "bytes2" }, { name: "identityHash", type: "bytes32" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" } ] },
      { name: "signature", type: "bytes" } ],
    outputs: [],
  },
] as const;

export const accountFactoryAbi = [
  { type: "function", name: "getAddress", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "createAccount", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bytes32" }], outputs: [{ type: "address" }] },
] as const;

export const callType = {
  type: "tuple[]", name: "calls",
  components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }],
} as const;

export const passkeyAccountAbi = [
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getDigest", stateMutability: "view", inputs: [callType, { name: "nonce_", type: "uint256" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "execute", stateMutability: "nonpayable", inputs: [callType, { name: "signature", type: "bytes" }], outputs: [] },
] as const;

export const webAuthnAuthType = {
  type: "tuple",
  components: [
    { name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "string" },
    { name: "challengeIndex", type: "uint256" }, { name: "typeIndex", type: "uint256" },
    { name: "r", type: "uint256" }, { name: "s", type: "uint256" } ],
} as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
] as const;

export const listingAbi = [
  { type: "function", name: "nextOrderId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "orderOf", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "seller", type: "address" }, { name: "batchId", type: "uint256" }, { name: "remainingKg", type: "uint256" },
      { name: "pricePerTonne", type: "uint256" }, { name: "minFillKg", type: "uint256" }, { name: "active", type: "bool" } ] }],
  },
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "buy", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [] },
] as const;

export const creditAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "heldBatches", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256[]" }] },
  {
    type: "function", name: "batchOf", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "projectId", type: "uint256" }, { name: "monitoringStart", type: "uint64" }, { name: "monitoringEnd", type: "uint64" },
      { name: "vintageYear", type: "uint16" }, { name: "serialHash", type: "bytes32" }, { name: "reportHash", type: "bytes32" },
      { name: "verifier", type: "address" }, { name: "issuedAt", type: "uint64" }, { name: "issuedKg", type: "uint256" },
      { name: "retiredKg", type: "uint256" }, { name: "frozen", type: "bool" } ] }],
  },
  {
    type: "function", name: "retire", stateMutability: "nonpayable",
    inputs: [{ name: "r", type: "tuple", components: [
      { name: "holder", type: "address" }, { name: "batchId", type: "uint256" }, { name: "amountKg", type: "uint256" },
      { name: "certificateTo", type: "address" }, { name: "beneficiaryHash", type: "bytes32" }, { name: "beneficiary", type: "string" },
      { name: "purpose", type: "uint8" }, { name: "memo", type: "string" } ] }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const registryAbi = [
  {
    type: "function", name: "projectOf", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "owner", type: "address" }, { name: "name", type: "string" }, { name: "methodology", type: "string" },
      { name: "location", type: "string" }, { name: "metadataURI", type: "string" }, { name: "active", type: "bool" } ] }],
  },
] as const;

export const poolAbi = [
  { type: "function", name: "pooledKg", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "redeemAndRetire", stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "bytes32" }, { type: "string" }, { type: "uint8" }, { type: "string" }],
    outputs: [{ type: "uint256[]" }],
  },
] as const;

export const poolKeyType = {
  type: "tuple", name: "key",
  components: [
    { name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" } ],
} as const;

export const routerAbi = [
  {
    type: "function", name: "swap", stateMutability: "nonpayable",
    inputs: [
      poolKeyType,
      { name: "params", type: "tuple", components: [
        { name: "zeroForOne", type: "bool" }, { name: "amountSpecified", type: "int256" }, { name: "sqrtPriceLimitX96", type: "uint160" } ] },
      { name: "minAmountOut", type: "uint256" }, { name: "deadline", type: "uint256" } ],
    outputs: [{ type: "int256" }],
  },
] as const;

export const poolManagerAbi = [
  { type: "function", name: "extsload", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
] as const;

export const certificateAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "certificateOf", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "batchId", type: "uint256" }, { name: "amountKg", type: "uint256" }, { name: "beneficiaryHash", type: "bytes32" },
      { name: "beneficiary", type: "string" }, { name: "purpose", type: "uint8" }, { name: "memo", type: "string" },
      { name: "retiredBy", type: "address" }, { name: "retiredAt", type: "uint64" }, { name: "documentHash", type: "bytes32" } ] }],
  },
  {
    type: "event", name: "Retired",
    inputs: [
      { name: "certId", type: "uint256", indexed: true }, { name: "batchId", type: "uint256", indexed: true },
      { name: "retiredBy", type: "address", indexed: true }, { name: "owner", type: "address", indexed: false },
      { name: "amountKg", type: "uint256", indexed: false }, { name: "beneficiaryHash", type: "bytes32", indexed: false },
      { name: "purpose", type: "uint8", indexed: false } ],
  },
] as const;

// ── 企業 / 查驗 / 管理 用 ──
export const registryWriteAbi = [
  { type: "function", name: "nextProjectId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "registerProject", stateMutability: "nonpayable",
    inputs: [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "serialUsed", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "attestationUsed", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "issue", stateMutability: "nonpayable",
    inputs: [{ name: "a", type: "tuple", components: [
      { name: "projectId", type: "uint256" }, { name: "monitoringStart", type: "uint64" }, { name: "monitoringEnd", type: "uint64" },
      { name: "amountKg", type: "uint256" }, { name: "serialHash", type: "bytes32" }, { name: "reportHash", type: "bytes32" },
      { name: "attestationId", type: "uint256" }, { name: "deadline", type: "uint256" } ] }, { name: "signature", type: "bytes" }],
    outputs: [{ type: "uint256" }] },
  { type: "event", name: "CreditsIssued", inputs: [
    { name: "projectId", type: "uint256", indexed: true }, { name: "batchId", type: "uint256", indexed: true },
    { name: "verifier", type: "address", indexed: true }, { name: "amountKg", type: "uint256", indexed: false },
    { name: "serialHash", type: "bytes32", indexed: false }, { name: "reportHash", type: "bytes32", indexed: false } ] },
] as const;

export const listingWriteAbi = [
  { type: "function", name: "list", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

export const poolWriteAbi = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

export const erc1155ApprovalAbi = [
  { type: "function", name: "setApprovalForAll", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bool" }], outputs: [] },
  { type: "function", name: "isApprovedForAll", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;

export const certificateWriteAbi = [
  { type: "function", name: "setDocumentHash", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "bytes32" }], outputs: [] },
] as const;

export const accessControlAbi = [
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;

export const ownedAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export const hookViewAbi = [
  { type: "function", name: "trustedRouter", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
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
