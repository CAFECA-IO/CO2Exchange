// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// 本機測試用的 CAFECA 替身（**不驗 P-256**——那是帳本查核工具要做的事，這裡只提供事件與介面）。
///
/// 事件與函式簽名照 Boltchain 8018 上 CAFECA 合約的實測（見專案文件 signature-model-decisions.md）：
///   KeyringValidator：KeyAdded(account, keyId, kind)、KeyRemoved(account, keyId)、getKey(account, keyId)
///   帳戶：ModuleInstalled／ModuleUninstalled(moduleTypeId, module)、isValidSignature（ERC-1271）
contract MockKeyring {
    struct Key { bytes32 qx; bytes32 qy; bytes32 rpIdHash; uint8 kind; uint64 addedAt; }
    mapping(address => mapping(bytes32 => Key)) internal _keys;

    event KeyAdded(address indexed account, bytes32 indexed keyId, uint8 kind);
    event KeyRemoved(address indexed account, bytes32 indexed keyId);

    function addKey(address account, bytes32 qx, bytes32 qy, bytes32 rpIdHash) external returns (bytes32 keyId) {
        keyId = keccak256(abi.encode(qx, qy));
        _keys[account][keyId] = Key(qx, qy, rpIdHash, 1, uint64(block.timestamp));
        emit KeyAdded(account, keyId, 1);
    }

    function removeKey(address account, bytes32 keyId) external {
        delete _keys[account][keyId];
        emit KeyRemoved(account, keyId);
    }

    function getKey(address account, bytes32 keyId) external view returns (bytes32, bytes32, bytes32, uint8, uint64) {
        Key memory k = _keys[account][keyId];
        return (k.qx, k.qy, k.rpIdHash, k.kind, k.addedAt);
    }

    function hasKey(address account, bytes32 keyId) external view returns (bool) {
        return _keys[account][keyId].qx != bytes32(0);
    }
}

contract MockCafecaAccount {
    struct WebAuthnSig { bytes authenticatorData; string clientDataJSON; uint256 challengeIndex; uint256 typeIndex; bytes32 r; bytes32 s; }
    struct SignatureData { bytes32 keyId; WebAuthnSig sig; }

    event ModuleInstalled(uint256 moduleTypeId, address module);
    event ModuleUninstalled(uint256 moduleTypeId, address module);

    address public keyring;

    constructor(address keyring_) {
        keyring = keyring_;
        emit ModuleInstalled(1, keyring_);
    }

    function uninstallKeyring() external {
        emit ModuleUninstalled(1, keyring);
        keyring = address(0);
    }

    /// 版面：validator (20 bytes) ‖ abi.encode(SignatureData)。只檢查 validator 與 keyId 目前有效。
    function isValidSignature(bytes32, bytes calldata signature) external view returns (bytes4) {
        if (signature.length < 20 || keyring == address(0)) return 0xffffffff;
        if (address(bytes20(signature[:20])) != keyring) return 0xffffffff;
        SignatureData memory d = abi.decode(signature[20:], (SignatureData));
        return MockKeyring(keyring).hasKey(address(this), d.keyId) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
