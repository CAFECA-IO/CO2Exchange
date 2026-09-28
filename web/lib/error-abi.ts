/// 平台上所有合約的自訂 error——由 scripts/gen-error-abi.mjs 產生，請勿手改。
///
/// 用途只有一個：**把 revert 的四個位元組翻譯成人看得懂的字**。
///
/// 前端其他的 ABI 常數都只放 function，因為呼叫只需要那些；
/// 但 revert 回來的是一個 selector，沒有對應的 error 定義就解不開，
/// 使用者看到的會是 `0x5c0dee5d` 這種東西。
///
/// 合約改了自訂 error 就要重跑：`cd web && node scripts/gen-error-abi.mjs`

export const errorAbi = [
  { type: "error", name: "AccessControlBadConfirmation", inputs: [] },
  { type: "error", name: "AccessControlUnauthorizedAccount", inputs: [{ name: "account", type: "address" }, { name: "neededRole", type: "bytes32" }] },
  { type: "error", name: "AddressEmptyCode", inputs: [{ name: "target", type: "address" }] },
  { type: "error", name: "BadLastSeq", inputs: [{ name: "given", type: "uint64" }, { name: "previous", type: "uint64" }] },
  { type: "error", name: "BadProof", inputs: [] },
  { type: "error", name: "BadProofLength", inputs: [] },
  { type: "error", name: "BadThreshold", inputs: [{ name: "threshold", type: "uint8" }] },
  { type: "error", name: "BadUpToBlock", inputs: [{ name: "upToBlock", type: "uint64" }, { name: "current", type: "uint256" }] },
  { type: "error", name: "ChainBroken", inputs: [{ name: "expected", type: "bytes32" }, { name: "got", type: "bytes32" }] },
  { type: "error", name: "ERC1155InsufficientBalance", inputs: [{ name: "sender", type: "address" }, { name: "balance", type: "uint256" }, { name: "needed", type: "uint256" }, { name: "tokenId", type: "uint256" }] },
  { type: "error", name: "ERC1155InvalidApprover", inputs: [{ name: "approver", type: "address" }] },
  { type: "error", name: "ERC1155InvalidArrayLength", inputs: [{ name: "idsLength", type: "uint256" }, { name: "valuesLength", type: "uint256" }] },
  { type: "error", name: "ERC1155InvalidOperator", inputs: [{ name: "operator", type: "address" }] },
  { type: "error", name: "ERC1155InvalidReceiver", inputs: [{ name: "receiver", type: "address" }] },
  { type: "error", name: "ERC1155InvalidSender", inputs: [{ name: "sender", type: "address" }] },
  { type: "error", name: "ERC1155MissingApprovalForAll", inputs: [{ name: "operator", type: "address" }, { name: "owner", type: "address" }] },
  { type: "error", name: "ERC20InsufficientAllowance", inputs: [{ name: "spender", type: "address" }, { name: "allowance", type: "uint256" }, { name: "needed", type: "uint256" }] },
  { type: "error", name: "ERC20InsufficientBalance", inputs: [{ name: "sender", type: "address" }, { name: "balance", type: "uint256" }, { name: "needed", type: "uint256" }] },
  { type: "error", name: "ERC20InvalidApprover", inputs: [{ name: "approver", type: "address" }] },
  { type: "error", name: "ERC20InvalidReceiver", inputs: [{ name: "receiver", type: "address" }] },
  { type: "error", name: "ERC20InvalidSender", inputs: [{ name: "sender", type: "address" }] },
  { type: "error", name: "ERC20InvalidSpender", inputs: [{ name: "spender", type: "address" }] },
  { type: "error", name: "ERC721IncorrectOwner", inputs: [{ name: "sender", type: "address" }, { name: "tokenId", type: "uint256" }, { name: "owner", type: "address" }] },
  { type: "error", name: "ERC721InsufficientApproval", inputs: [{ name: "operator", type: "address" }, { name: "tokenId", type: "uint256" }] },
  { type: "error", name: "ERC721InvalidApprover", inputs: [{ name: "approver", type: "address" }] },
  { type: "error", name: "ERC721InvalidOperator", inputs: [{ name: "operator", type: "address" }] },
  { type: "error", name: "ERC721InvalidOwner", inputs: [{ name: "owner", type: "address" }] },
  { type: "error", name: "ERC721InvalidReceiver", inputs: [{ name: "receiver", type: "address" }] },
  { type: "error", name: "ERC721InvalidSender", inputs: [{ name: "sender", type: "address" }] },
  { type: "error", name: "ERC721NonexistentToken", inputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "error", name: "EpochOutOfOrder", inputs: [{ name: "expected", type: "uint64" }, { name: "got", type: "uint64" }] },
  { type: "error", name: "FailedCall", inputs: [] },
  { type: "error", name: "FailedDeployment", inputs: [] },
  { type: "error", name: "Insolvent", inputs: [{ name: "owed", type: "uint256" }, { name: "held", type: "uint256" }] },
  { type: "error", name: "InsufficientBalance", inputs: [{ name: "balance", type: "uint256" }, { name: "needed", type: "uint256" }] },
  { type: "error", name: "MissingPrecompile", inputs: [{ name: "", type: "address" }] },
  { type: "error", name: "NotLatestEpoch", inputs: [{ name: "latest", type: "uint64" }, { name: "got", type: "uint64" }] },
  { type: "error", name: "NothingLeft", inputs: [{ name: "account", type: "address" }, { name: "epoch", type: "uint64" }] },
  { type: "error", name: "PublicKeyOnPublicChain", inputs: [{ name: "role", type: "string" }, { name: "who", type: "address" }, { name: "chainId", type: "uint256" }] },
  { type: "error", name: "SafeERC20FailedDecreaseAllowance", inputs: [{ name: "spender", type: "address" }, { name: "currentAllowance", type: "uint256" }, { name: "requestedDecrease", type: "uint256" }] },
  { type: "error", name: "SafeERC20FailedOperation", inputs: [{ name: "token", type: "address" }] },
  { type: "error", name: "SumMismatch", inputs: [{ name: "expected", type: "uint256" }, { name: "got", type: "uint256" }] },
  { type: "error", name: "SumOverflow", inputs: [] },
  { type: "error", name: "TimelockInsufficientDelay", inputs: [{ name: "delay", type: "uint256" }, { name: "minDelay", type: "uint256" }] },
  { type: "error", name: "TimelockInvalidOperationLength", inputs: [{ name: "targets", type: "uint256" }, { name: "payloads", type: "uint256" }, { name: "values", type: "uint256" }] },
  { type: "error", name: "TimelockUnauthorizedCaller", inputs: [{ name: "caller", type: "address" }] },
  { type: "error", name: "TimelockUnexecutedPredecessor", inputs: [{ name: "predecessorId", type: "bytes32" }] },
  { type: "error", name: "TimelockUnexpectedOperationState", inputs: [{ name: "operationId", type: "bytes32" }, { name: "expectedStates", type: "bytes32" }] },
  { type: "error", name: "UnknownEpoch", inputs: [{ name: "epoch", type: "uint64" }] },
  { type: "error", name: "WithdrawalsDisabled", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  // Solidity 內建的兩個：revert("...") 與 assert 失敗
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
  { type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] },
] as const;
