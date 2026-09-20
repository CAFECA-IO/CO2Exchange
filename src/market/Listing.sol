// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {
    ERC1155HolderUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC1155/utils/ERC1155HolderUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IKYCRegistry} from "../interfaces/IKYCRegistry.sol";
import {CarbonCredit1155} from "../registry/CarbonCredit1155.sol";
import {IJurisdictions} from "../interfaces/IJurisdictions.sol";
import {FeeSchedule} from "./FeeSchedule.sol";

/// @title Listing
/// @notice Phase 1 主市場：減量企業以專案名義、自訂價格掛單整批額度；買方以結算代幣成交。
///         UUPS 可升級；升級權在 DEFAULT_ADMIN（國家單位 Timelock）。
///
/// 白名單：本合約為 SystemContract。掛單時 1155 由賣方轉入本合約（_update 檢查賣方），
///         成交時由本合約轉給買方（_update 檢查買方）。自然人因政策不可轉出，故自然不能掛單。
contract Listing is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    ERC1155HolderUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant SOVEREIGN_ROLE = keccak256("SOVEREIGN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint256 public constant MAX_FEE_BPS = 500; // 5%
    uint256 public constant KG_PER_TONNE = 1000;

    struct Order {
        address seller;
        uint256 batchId;
        uint256 remainingKg;
        uint256 pricePerTonne; // 結算代幣最小單位 / 噸
        uint256 minFillKg;
        bool active;
    }

    IKYCRegistry public kyc;
    CarbonCredit1155 public credit;
    IERC20 public settlementToken;
    address public treasury;
    uint256 public feeBps;
    /// @dev 各國費率表。為 0 時退回單一費率 feeBps——舊部署不會因為多了這個欄位就壞掉。
    FeeSchedule public feeSchedule;

    uint256 public nextOrderId;
    mapping(uint256 => Order) private _orders;

    event Listed(
        uint256 indexed orderId,
        address indexed seller,
        uint256 indexed batchId,
        uint256 amountKg,
        uint256 pricePerTonne,
        uint256 minFillKg
    );
    event Filled(uint256 indexed orderId, address indexed buyer, uint256 amountKg, uint256 cost, uint256 fee);
    event Cancelled(uint256 indexed orderId, uint256 returnedKg);
    event FeeUpdated(uint256 feeBps, address treasury);
    event FeeScheduleUpdated(address feeSchedule);

    error NotCorporate(address account);
    error NotActiveAccount(address account);
    error OrderInactive(uint256 orderId);
    error NotSeller();
    error BelowMinFill();
    error ExceedsRemaining();
    error FeeTooHigh();
    error ZeroAmount();
    error ZeroAddress();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address sovereign,
        address operator,
        IKYCRegistry kyc_,
        CarbonCredit1155 credit_,
        IERC20 settlementToken_,
        address treasury_,
        uint256 feeBps_
    ) external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __ERC1155Holder_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SOVEREIGN_ROLE, sovereign);
        _grantRole(OPERATOR_ROLE, operator);
        _setRoleAdmin(OPERATOR_ROLE, SOVEREIGN_ROLE);
        kyc = kyc_;
        credit = credit_;
        settlementToken = settlementToken_;
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        feeBps = feeBps_;
        nextOrderId = 1;
    }

    // ───────────────────────── 營運 ─────────────────────────

    /// @notice 掛上（或拆掉）各國費率表。拆掉之後所有轄區回到單一費率。
    function setFeeSchedule(FeeSchedule feeSchedule_) external onlyRole(OPERATOR_ROLE) {
        feeSchedule = feeSchedule_;
        emit FeeScheduleUpdated(address(feeSchedule_));
    }

    /// @notice 這一筆掛單適用的手續費率（bps）。
    function feeBpsOf(uint256 batchId) public view returns (uint256) {
        if (address(feeSchedule) == address(0)) return feeBps;
        (bytes2 c,) = IJurisdictions(credit.registry()).jurisdictionOfProject(credit.batchOf(batchId).projectId);
        return feeSchedule.tradeBpsOf(c);
    }

    function setFee(uint256 feeBps_, address treasury_) external onlyRole(OPERATOR_ROLE) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (treasury_ == address(0)) revert ZeroAddress();
        feeBps = feeBps_;
        treasury = treasury_;
        emit FeeUpdated(feeBps_, treasury_);
    }

    /// @dev 暫停是緊急權：營運與主權都可以；恢復只有營運（避免主權誤觸後無人能停）。
    function pause() external {
        if (!hasRole(OPERATOR_ROLE, msg.sender) && !hasRole(SOVEREIGN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, OPERATOR_ROLE);
        }
        _pause();
    }

    function unpause() external onlyRole(OPERATOR_ROLE) {
        _unpause();
    }

    // ───────────────────────── 掛單 ─────────────────────────

    function list(uint256 batchId, uint256 amountKg, uint256 pricePerTonne, uint256 minFillKg)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 orderId)
    {
        if (amountKg == 0) revert ZeroAmount();
        // 掛單不限法人：自然人買到之後要能再賣出（他無法註銷，轉售是他唯一的出場方式）。
        // 「誰可以把額度轉出去」是身分層的政策，由 CarbonCredit1155._update → checkTransfer 決定，
        // 不在這裡重複一套規則——兩個地方各寫一次，遲早會不一致。
        if (!kyc.isActive(msg.sender)) revert NotActiveAccount(msg.sender);
        // 轄區可以被主權角色關掉（例如某國登錄簿出事、或本站尚未取得該國額度的處理管道）。
        // 關掉之後既有持有不受影響，但不能再上架——流動性可以停，持有不能沒收。
        IJurisdictions(credit.registry()).checkTradable(credit.batchOf(batchId).projectId);
        orderId = nextOrderId++;
        _orders[orderId] = Order({
            seller: msg.sender,
            batchId: batchId,
            remainingKg: amountKg,
            pricePerTonne: pricePerTonne,
            minFillKg: minFillKg,
            active: true
        });
        credit.safeTransferFrom(msg.sender, address(this), batchId, amountKg, "");
        emit Listed(orderId, msg.sender, batchId, amountKg, pricePerTonne, minFillKg);
    }

    function buy(uint256 orderId, uint256 amountKg) external nonReentrant whenNotPaused {
        Order storage o = _orders[orderId];
        if (!o.active) revert OrderInactive(orderId);
        if (!kyc.isActive(msg.sender)) revert NotActiveAccount(msg.sender);
        if (amountKg == 0) revert ZeroAmount();
        if (amountKg > o.remainingKg) revert ExceedsRemaining();
        if (amountKg < o.minFillKg && amountKg != o.remainingKg) revert BelowMinFill();

        uint256 cost = amountKg * o.pricePerTonne / KG_PER_TONNE;
        uint256 fee = cost * feeBpsOf(o.batchId) / 10_000;

        o.remainingKg -= amountKg;
        if (o.remainingKg == 0) o.active = false;

        settlementToken.safeTransferFrom(msg.sender, o.seller, cost - fee);
        if (fee > 0) settlementToken.safeTransferFrom(msg.sender, treasury, fee);
        credit.safeTransferFrom(address(this), msg.sender, o.batchId, amountKg, "");

        emit Filled(orderId, msg.sender, amountKg, cost, fee);
    }

    function cancel(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (!o.active) revert OrderInactive(orderId);
        if (o.seller != msg.sender && !hasRole(OPERATOR_ROLE, msg.sender)) revert NotSeller();
        uint256 remaining = o.remainingKg;
        o.active = false;
        o.remainingKg = 0;
        credit.safeTransferFrom(address(this), o.seller, o.batchId, remaining, "");
        emit Cancelled(orderId, remaining);
    }

    function orderOf(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlUpgradeable, ERC1155HolderUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
