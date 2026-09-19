// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @title WebAuthn
/// @notice 驗證 WebAuthn (passkey) 斷言簽章。結構與 viem / Coinbase Smart Wallet 的編碼相容，
///         前端可直接用 viem 的 `toWebAuthnAccount().sign()` 產生。
///         P-256 驗簽走 OpenZeppelin P256：有 RIP-7212 precompile 時用 precompile，否則純 Solidity。
library WebAuthn {
    struct WebAuthnAuth {
        bytes authenticatorData;
        string clientDataJSON;
        uint256 challengeIndex; // clientDataJSON 中 `"challenge":"` 的起點
        uint256 typeIndex; // clientDataJSON 中 `"type":"` 的起點
        uint256 r;
        uint256 s;
    }

    bytes1 private constant AUTH_DATA_FLAGS_UP = 0x01;
    bytes1 private constant AUTH_DATA_FLAGS_UV = 0x04;
    uint256 private constant P256_N_DIV_2 = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8;

    /// @param challenge 原始 challenge（本專案為 32 bytes digest）
    /// @param requireUV 是否要求 user verification（FaceID / TouchID / PIN）
    function verify(bytes memory challenge, bool requireUV, WebAuthnAuth memory auth, bytes32 qx, bytes32 qy)
        internal
        view
        returns (bool)
    {
        if (auth.s > P256_N_DIV_2) return false; // 拒絕可延展簽章
        if (auth.authenticatorData.length < 37) return false;

        // 1. type == webauthn.get
        bytes memory typeSlice = _slice(bytes(auth.clientDataJSON), auth.typeIndex, 21);
        if (keccak256(typeSlice) != keccak256(bytes('"type":"webauthn.get"'))) return false;

        // 2. challenge 相符（base64url）
        string memory expected = string.concat('"challenge":"', Base64.encodeURL(challenge), '"');
        bytes memory challengeSlice = _slice(bytes(auth.clientDataJSON), auth.challengeIndex, bytes(expected).length);
        if (keccak256(challengeSlice) != keccak256(bytes(expected))) return false;

        // 3. flags
        bytes1 flags = auth.authenticatorData[32];
        if (flags & AUTH_DATA_FLAGS_UP != AUTH_DATA_FLAGS_UP) return false;
        if (requireUV && flags & AUTH_DATA_FLAGS_UV != AUTH_DATA_FLAGS_UV) return false;

        // 4. message = authenticatorData || sha256(clientDataJSON)
        bytes32 clientDataHash = sha256(bytes(auth.clientDataJSON));
        bytes32 messageHash = sha256(abi.encodePacked(auth.authenticatorData, clientDataHash));

        return P256.verify(messageHash, bytes32(auth.r), bytes32(auth.s), qx, qy);
    }

    function _slice(bytes memory data, uint256 start, uint256 len) private pure returns (bytes memory out) {
        if (start + len > data.length) return out; // 空 → 比對必失敗
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = data[start + i];
        }
    }
}
