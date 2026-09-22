// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {PasskeyAccount} from "./PasskeyAccount.sol";

/// @notice 一個登入帳號一個錢包。
///
/// 地址由 `accountRef`（登入帳號識別碼的雜湊）決定，**不是**由第一把 passkey 決定。
/// 差別在使用者換裝置的時候看得出來：綁在 passkey 上的話，換一台手機就是換一個錢包，
/// 舊錢包裡的碳權不會跟過來；綁在登入帳號上，換幾台裝置都還是同一個錢包，
/// passkey 只是「能開這個錢包的鑰匙」，可以配好幾把，也可以撤掉其中一把。
///
/// 代價要說清楚：地址既然只由 accountRef 決定，**平台在使用者第一次登入之前，
/// 就有能力用自己的金鑰把那個地址部署掉**。防線不在合約而在制度——accountRef 與
/// 首次綁定的金鑰都會上鏈且公開可查，使用者發現帳戶已存在、金鑰卻不是自己的，
/// 可循復原程序（重新驗證身分）取回。要在合約層面根除這個風險，得讓地址由第一把
/// passkey 決定，但那就換不了裝置了——這是一個取捨，不是疏漏。
contract PasskeyAccountFactory {
    /// 復原代理人（治理 Safe）與平台 relayer，在部署時固定，所有帳戶共用同一組。
    address public immutable recoveryAgent;
    address public immutable operator;

    event AccountCreated(address indexed account, bytes32 indexed accountRef, bytes32 qx, bytes32 qy);

    constructor(address recoveryAgent_, address operator_) {
        recoveryAgent = recoveryAgent_;
        operator = operator_;
    }

    /// @notice 建立（或取回）這個登入帳號的錢包，並把第一把 passkey 設為初始金鑰。
    /// @dev 已經存在就直接回傳，**不動它的金鑰**——否則任何人送一把新公鑰進來，
    ///      就能替別人的帳戶換鎖。要加金鑰請走帳戶自己的 addKey（需現有金鑰簽章）。
    function createAccount(bytes32 accountRef, bytes32 qx, bytes32 qy, string calldata label)
        external
        returns (PasskeyAccount account)
    {
        address predicted = getAddress(accountRef);
        if (predicted.code.length > 0) return PasskeyAccount(payable(predicted));
        account = new PasskeyAccount{salt: accountRef}(accountRef, recoveryAgent, operator);
        account.initialise(qx, qy, label);
        emit AccountCreated(address(account), accountRef, qx, qy);
    }

    /// @notice 這個登入帳號的錢包地址。不需要知道任何金鑰就算得出來——
    ///         這正是「換裝置還是同一個錢包」的機制基礎。
    function getAddress(bytes32 accountRef) public view returns (address) {
        return Create2.computeAddress(
            accountRef,
            keccak256(
                abi.encodePacked(type(PasskeyAccount).creationCode, abi.encode(accountRef, recoveryAgent, operator))
            )
        );
    }
}
