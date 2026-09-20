import { parseAbiItem } from "viem";

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
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
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

const jurisdictionType = {
  type: "tuple", components: [
    { name: "enabled", type: "bool" }, { name: "domestic", type: "bool" }, { name: "purposeMask", type: "uint8" },
    { name: "name", type: "string" }, { name: "scheme", type: "string" }, { name: "registryName", type: "string" },
    { name: "note", type: "string" } ],
} as const;

export const registryAbi = [
  {
    type: "function", name: "projectOf", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "owner", type: "address" }, { name: "name", type: "string" }, { name: "methodology", type: "string" },
      { name: "location", type: "string" }, { name: "metadataURI", type: "string" }, { name: "active", type: "bool" },
      { name: "country", type: "bytes2" }, { name: "scheme", type: "string" } ] }],
  },
  { type: "function", name: "countries", stateMutability: "view", inputs: [], outputs: [{ type: "bytes2[]" }] },
  { type: "function", name: "jurisdictionOf", stateMutability: "view", inputs: [{ type: "bytes2" }], outputs: [jurisdictionType] },
  {
    type: "function", name: "jurisdictionOfProject", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "bytes2" }, jurisdictionType],
  },
] as const;

/// 各國費率表
export const feeScheduleAbi = [
  { type: "function", name: "defaultTradeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "defaultRetireFeePerTonne", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "countryFeeOf", stateMutability: "view", inputs: [{ type: "bytes2" }],
    outputs: [{ type: "tuple", components: [
      { name: "set", type: "bool" }, { name: "tradeBps", type: "uint16" }, { name: "retireFeePerTonne", type: "uint256" } ] }],
  },
  { type: "function", name: "setDefaults", stateMutability: "nonpayable", inputs: [{ type: "uint16" }, { type: "uint256" }], outputs: [] },
  {
    type: "function", name: "setCountryFee", stateMutability: "nonpayable",
    inputs: [{ type: "bytes2" }, { type: "bool" }, { type: "uint16" }, { type: "uint256" }], outputs: [],
  },
] as const;

/// 託管與準備金揭露
export const reserveAbi = [
  { type: "function", name: "latestReportId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "periods", stateMutability: "view", inputs: [], outputs: [{ type: "uint32[]" }] },
  { type: "function", name: "reportOfPeriod", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "reportOf", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [
      { name: "report", type: "tuple", components: [
        { name: "period", type: "uint32" }, { name: "asOf", type: "uint64" }, { name: "publishedAt", type: "uint64" },
        { name: "attestedAt", type: "uint64" }, { name: "publisher", type: "address" }, { name: "auditor", type: "address" },
        { name: "auditorName", type: "string" }, { name: "status", type: "uint8" }, { name: "note", type: "string" },
        { name: "documentHash", type: "bytes32" } ] },
      { name: "credits", type: "tuple[]", components: [
        { name: "country", type: "bytes2" }, { name: "custodian", type: "string" }, { name: "accountRef", type: "string" },
        { name: "heldKg", type: "uint256" }, { name: "onchainKg", type: "uint256" }, { name: "statementHash", type: "bytes32" } ] },
      { name: "cash", type: "tuple", components: [
        { name: "trustee", type: "string" }, { name: "accountRef", type: "string" }, { name: "balance", type: "uint256" },
        { name: "tokenSupply", type: "uint256" }, { name: "statementHash", type: "bytes32" } ] },
    ],
  },
] as const;

export const poolAbi = [
  { type: "function", name: "pooledKg", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [] },
  {
    type: "function", name: "redeem", stateMutability: "nonpayable", inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint256[]" }, { type: "uint256[]" }],
  },
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
      { name: "retiredBy", type: "address" }, { name: "retiredAt", type: "uint64" }, { name: "documentHash", type: "bytes32" },
      // 官方註銷回填：編號與主管機關公開日
      { name: "officialNo", type: "string" }, { name: "officialAnnouncedAt", type: "uint64" },
      { name: "country", type: "bytes2" }, { name: "scheme", type: "string" } ] }],
  },
  {
    type: "event", name: "Retired",
    inputs: [
      { name: "certId", type: "uint256", indexed: true }, { name: "batchId", type: "uint256", indexed: true },
      { name: "retiredBy", type: "address", indexed: true }, { name: "owner", type: "address", indexed: false },
      { name: "amountKg", type: "uint256", indexed: false }, { name: "beneficiaryHash", type: "bytes32", indexed: false },
      { name: "purpose", type: "uint8", indexed: false }, { name: "country", type: "bytes2", indexed: false } ],
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
  { type: "function", name: "setOfficialRetirement", stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "string" }, { type: "uint64" }], outputs: [] },
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

/// 事件簽章集中在這裡，不要在各自的模組裡再抄一份。
///
/// 抄一份的代價不是重複，是**安靜的錯**：`getLogs` 找不到相符的事件時不會報錯，
/// 它回一個空陣列，於是整頁數字變成零，看起來像「還沒有人交易」而不是「查錯東西」。
/// 這個 bug 在 by-country 上發生過一次——事件叫 BatchIssued，那邊寫成 Issued。
export const EVENTS = {
  batchIssued: parseAbiItem(
    "event BatchIssued(uint256 indexed batchId, uint256 indexed projectId, address indexed to, uint256 amountKg, bytes32 serialHash)",
  ),
  creditRetired: parseAbiItem(
    "event CreditRetired(uint256 indexed batchId, address indexed holder, address indexed certificateOwner, uint256 amountKg, uint256 certId)",
  ),
  filled: parseAbiItem(
    "event Filled(uint256 indexed orderId, address indexed buyer, uint256 amountKg, uint256 cost, uint256 fee)",
  ),
} as const;
