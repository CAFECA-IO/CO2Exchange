// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {PasskeyAccount} from "./PasskeyAccount.sol";

/// @notice 以 passkey 公鑰決定帳戶地址（CREATE2）。任何人可代為部署，通常由平台 relayer 在首次登入時執行。
contract PasskeyAccountFactory {
    event AccountCreated(address indexed account, bytes32 qx, bytes32 qy);

    function createAccount(bytes32 qx, bytes32 qy) external returns (PasskeyAccount account) {
        address predicted = getAddress(qx, qy);
        if (predicted.code.length > 0) return PasskeyAccount(payable(predicted));
        account = new PasskeyAccount{salt: _salt(qx, qy)}(qx, qy);
        emit AccountCreated(address(account), qx, qy);
    }

    function getAddress(bytes32 qx, bytes32 qy) public view returns (address) {
        return Create2.computeAddress(
            _salt(qx, qy), keccak256(abi.encodePacked(type(PasskeyAccount).creationCode, abi.encode(qx, qy)))
        );
    }

    function _salt(bytes32 qx, bytes32 qy) internal pure returns (bytes32) {
        return keccak256(abi.encode(qx, qy));
    }
}
