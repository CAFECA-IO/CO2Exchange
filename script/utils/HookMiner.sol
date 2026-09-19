// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice 為 Uniswap v4 hook 挖出符合權限旗標的 CREATE2 地址。
///         Foundry script 的 CREATE2 透過標準 deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C 執行。
library HookMiner {
    uint160 internal constant FLAG_MASK = 0x3FFF;
    uint256 internal constant MAX_LOOP = 200_000;

    function find(address deployer, uint160 flags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        view
        returns (address hookAddress, bytes32 salt)
    {
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, constructorArgs));
        for (uint256 i = 0; i < MAX_LOOP; i++) {
            salt = bytes32(i);
            hookAddress =
                address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
            if (uint160(hookAddress) & FLAG_MASK == flags && hookAddress.code.length == 0) return (hookAddress, salt);
        }
        revert("HookMiner: no salt found");
    }
}
