// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice 代幣合約實作此介面，讓 KYCRegistry 在帳戶復原（金鑰遺失、承辦人異動）時搬移餘額。
interface IRecoverable {
    function recoverBalances(address from, address to) external;
}
