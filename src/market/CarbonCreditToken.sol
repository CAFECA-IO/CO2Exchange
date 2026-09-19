// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IKYCRegistry} from "../interfaces/IKYCRegistry.sol";
import {IRecoverable} from "../interfaces/IRecoverable.sol";

/// @title CarbonCreditToken (CCT)
/// @notice 同年份池化代幣（ERC-20，18 decimals；1 CCT = 1 tCO2e）。
///         只有 CarbonPool 可 mint / burn。轉帳受 KYCRegistry 白名單約束。
///         不做 fee-on-transfer、不做 rebasing —— Uniswap v4 flash accounting 的硬性前提。
contract CarbonCreditToken is Initializable, UUPSUpgradeable, AccessControlUpgradeable, ERC20Upgradeable, IRecoverable {
    bytes32 public constant POOL_ROLE = keccak256("POOL_ROLE");

    IKYCRegistry public kyc;
    uint16 public vintageYear;

    error OnlyKYC();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        IKYCRegistry kyc_,
        uint16 vintageYear_,
        string memory name_,
        string memory symbol_
    ) external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ERC20_init(name_, symbol_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        kyc = kyc_;
        vintageYear = vintageYear_;
    }

    function mint(address to, uint256 amount) external onlyRole(POOL_ROLE) {
        _mint(to, amount);
    }

    function burnFrom(address from, uint256 amount) external onlyRole(POOL_ROLE) {
        _burn(from, amount);
    }

    function recoverBalances(address from, address to) external {
        if (msg.sender != address(kyc)) revert OnlyKYC();
        uint256 bal = balanceOf(from);
        if (bal > 0) {
            _recovering = true;
            _update(from, to, bal);
            _recovering = false;
        }
    }

    bool private _recovering;

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && !_recovering) {
            kyc.checkTransfer(from, to);
        }
        super._update(from, to, value);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
