// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title LedgerMerkle
/// @notice 帳本 v2 的一般 Merkle 樹（登錄簿、身分、事件包含證據）。
///
/// @dev **必須與 `web/lib/ledger/merkle.ts` 逐位元組一致**，由 `test/LedgerFixture.t.sol`
///      讀 TypeScript 產生的 fixture 守著。規則：
///        · 葉子 = keccak256(abi.encode(bytes1(0x00), contentHash))
///        · 節點 = keccak256(abi.encode(bytes1(0x01), left, right))
///        · 落單節點往上帶，不補假葉子；path 第 i 位為 1 代表第 i 個兄弟在左邊
///      用 `abi.encode` 而不是 packed：內容本身就是 abi.encode 的雜湊，兩邊只要各寫一行。
library LedgerMerkle {
    error BadProofLength();

    function leaf(bytes32 content) internal pure returns (bytes32) {
        return keccak256(abi.encode(bytes1(0x00), content));
    }

    function node(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        return keccak256(abi.encode(bytes1(0x01), l, r));
    }

    function computeRoot(bytes32 h, bytes32[] calldata siblings, uint256 path) internal pure returns (bytes32) {
        if (siblings.length > 255) revert BadProofLength();
        for (uint256 i = 0; i < siblings.length; i++) {
            h = (path >> i) & 1 == 1 ? node(siblings[i], h) : node(h, siblings[i]);
        }
        return h;
    }
}
