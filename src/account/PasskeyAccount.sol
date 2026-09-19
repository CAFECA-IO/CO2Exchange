// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {WebAuthn} from "./WebAuthn.sol";

/// @title PasskeyAccount
/// @notice 使用者的鏈上帳戶。唯一擁有者是一把 P-256 passkey（存在裝置 Keychain / Google Password Manager），
///         沒有助記詞、沒有第三方託管。地址由 Factory 以 CREATE2(salt = hash(公鑰)) 決定，
///         同一把 passkey 在任何裝置都對到同一個地址 —— KYC 白名單綁在這個地址上。
///
/// Phase 0：交易由平台 relayer 代送（`execute` 任何人可呼叫，授權來自 WebAuthn 簽章），gas 由平台付。
/// Phase 1：換成 ERC-4337 EntryPoint + paymaster；簽章格式與 nonce 語意不變，只換傳輸層。
contract PasskeyAccount is IERC1155Receiver, IERC721Receiver, IERC1271 {
    bytes32 public immutable qx;
    bytes32 public immutable qy;
    uint256 public nonce;

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    bytes32 private constant DOMAIN = keccak256("CO2Exchange PasskeyAccount v1");

    event Executed(uint256 indexed nonce, uint256 calls);

    error InvalidSignature();
    error CallFailed(uint256 index, bytes reason);

    constructor(bytes32 qx_, bytes32 qy_) {
        qx = qx_;
        qy = qy_;
    }

    receive() external payable {}

    /// @notice 要簽的 digest：綁 chainId、帳戶地址、nonce 與呼叫內容，防跨鏈 / 跨帳戶 / 重放。
    function getDigest(Call[] calldata calls, uint256 nonce_) public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN, block.chainid, address(this), nonce_, keccak256(abi.encode(calls))));
    }

    /// @param signature abi.encode(WebAuthn.WebAuthnAuth)
    function execute(Call[] calldata calls, bytes calldata signature) external {
        bytes32 digest = getDigest(calls, nonce);
        WebAuthn.WebAuthnAuth memory auth = abi.decode(signature, (WebAuthn.WebAuthnAuth));
        if (!WebAuthn.verify(abi.encodePacked(digest), false, auth, qx, qy)) revert InvalidSignature();
        uint256 n = nonce++;
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
        emit Executed(n, calls.length);
    }

    // ── ERC-1271：讓其他合約（例如未來的 EIP-712 掛單）能驗此帳戶的簽章 ──
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        WebAuthn.WebAuthnAuth memory auth = abi.decode(signature, (WebAuthn.WebAuthnAuth));
        return
            WebAuthn.verify(abi.encodePacked(hash), false, auth, qx, qy)
                ? IERC1271.isValidSignature.selector
                : bytes4(0);
    }

    // ── receivers ──
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IERC1155Receiver).interfaceId
            || id == type(IERC721Receiver).interfaceId || id == type(IERC1271).interfaceId;
    }
}
