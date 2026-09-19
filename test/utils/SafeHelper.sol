// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Safe} from "safe-smart-account/Safe.sol";
import {Enum} from "safe-smart-account/common/Enum.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice 測試用：以 EOA 私鑰對 Safe 交易簽章並執行（等同 Safe UI 的 confirm + execute）。
library SafeHelper {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @param pks 簽章者私鑰（任意順序；Safe 要求簽章依 owner 地址升冪排列，這裡自動排序）
    function exec(Safe safe, uint256[] memory pks, address to, bytes memory data) internal returns (bool) {
        bytes memory sigs = _sign(safe, pks, _txHash(safe, to, data));
        return safe.execTransaction(to, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sigs);
    }

    /// @notice 預期 Safe 執行失敗（內部呼叫 revert → GS013，或簽章不足 → GS020）。
    ///         必須在這裡下 expectRevert，否則會被前面的 view 呼叫（nonce()）吃掉。
    function execExpectRevert(Safe safe, uint256[] memory pks, address to, bytes memory data) internal {
        bytes memory sigs = _sign(safe, pks, _txHash(safe, to, data));
        vm.expectRevert();
        safe.execTransaction(to, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sigs);
    }

    function executeExpectRevert(
        Safe safe,
        uint256[] memory pks,
        TimelockController tl,
        address target,
        bytes memory data,
        bytes32 salt
    ) internal {
        execExpectRevert(
            safe, pks, address(tl), abi.encodeCall(TimelockController.execute, (target, 0, data, bytes32(0), salt))
        );
    }

    function _txHash(Safe safe, address to, bytes memory data) private view returns (bytes32) {
        uint256 nonce = safe.nonce();
        return safe.getTransactionHash(to, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), address(0), nonce);
    }

    function _sign(Safe, uint256[] memory pks, bytes32 txHash) private pure returns (bytes memory sigs) {
        // 依地址排序
        for (uint256 i = 1; i < pks.length; i++) {
            uint256 k = pks[i];
            uint256 j = i;
            while (j > 0 && vm.addr(pks[j - 1]) > vm.addr(k)) {
                pks[j] = pks[j - 1];
                j--;
            }
            pks[j] = k;
        }
        for (uint256 i = 0; i < pks.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], txHash);
            sigs = abi.encodePacked(sigs, r, s, v);
        }
    }

    /// @notice 透過 Safe 向 Timelock 排程一筆操作
    function schedule(
        Safe safe,
        uint256[] memory pks,
        TimelockController tl,
        address target,
        bytes memory data,
        bytes32 salt
    ) internal {
        exec(
            safe,
            pks,
            address(tl),
            abi.encodeCall(TimelockController.schedule, (target, 0, data, bytes32(0), salt, tl.getMinDelay()))
        );
    }

    /// @notice 透過 Safe 執行 Timelock 中已到期的操作
    function execute(
        Safe safe,
        uint256[] memory pks,
        TimelockController tl,
        address target,
        bytes memory data,
        bytes32 salt
    ) internal {
        exec(safe, pks, address(tl), abi.encodeCall(TimelockController.execute, (target, 0, data, bytes32(0), salt)));
    }
}
