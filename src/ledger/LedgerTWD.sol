// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title LedgerTWD
/// @notice 平台的新台幣記帳代幣。**只存在於帳本合約裡**，純粹是審計數據。
///
/// 使用者的新台幣存在信託專戶；營運 Safe 確認一筆入金到帳，帳本合約就鑄同額的 TWD 給**自己**；
/// 出金匯出之後，帳本合約銷毀同額。所以任何時候：
///
/// ```
/// totalSupply() == balanceOf(帳本合約) == 營運方宣稱信託專戶裡屬於使用者的新台幣
/// ```
///
/// 而每一期承諾的 `totalCash`（帳本說欠使用者多少）不得超過它。
///
/// **不可轉讓**：唯一的持有人是帳本合約，`transfer`／`transferFrom` 一律 revert。
/// 平台上的新台幣與碳權都提不出鏈外錢包——它不是支付工具，也不是儲值工具，只是一份
/// 任何人都能讀的「入金總額 − 出金總額」。
contract LedgerTWD is ERC20 {
    /// @notice 帳本合約。只有它能鑄、能銷，而且只鑄給自己、只從自己銷。
    address public immutable ledger;

    error NotLedger();
    error NonTransferable();

    constructor() ERC20(unicode"TideBit-DeFi 新台幣（帳本）", "TWD") {
        ledger = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(uint256 amount) external {
        if (msg.sender != ledger) revert NotLedger();
        _mint(ledger, amount);
    }

    function burn(uint256 amount) external {
        if (msg.sender != ledger) revert NotLedger();
        _burn(ledger, amount);
    }

    /// @dev 只允許鑄（from = 0）與銷（to = 0）。
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) revert NonTransferable();
        super._update(from, to, value);
    }
}
