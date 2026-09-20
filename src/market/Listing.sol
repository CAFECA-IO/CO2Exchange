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

    /// @notice 買單。賣單是「我有這一批，賣這個價」；買單是「我要這一國的額度，出這個價」。
    ///
    /// 買方指定的是**核發國**而不是批次——他還沒有那批額度，指不了；而核發國決定了
    /// 法律效力與可用途徑，本來就是買方真正在意的條件。年份與專案交給賣方挑。
    /// `country` 為 0x0000 表示不限。
    struct Bid {
        address buyer;
        bytes2 country;
        uint256 remainingKg;
        uint256 pricePerTonne; // 結算代幣最小單位 / 噸
        uint256 minFillKg;
        bool active;
        /// @dev 還鎖著多少錢。**記下來，不要每次用數量乘回去算。**
        ///      託管是 floor(數量 × 單價 / 1000) 收一次，付款是每次成交各 floor 一次，
        ///      兩邊的無條件捨去對不起來，餘數會留在合約裡沒有人領得走。
        ///      實測 180 張買單累積了 62 個最小單位——金額微不足道，
        ///      但「合約餘額 = 所有有效買單的託管總和」這條不變式就不成立了，
        ///      而這種帳是要給稽核看的。
        uint256 escrow;
    }

    /// @dev 這兩個是後來才加的，只能附加在既有變數之後——UUPS 的儲存配置不能插隊。
    uint256 public nextBidId;
    mapping(uint256 => Bid) private _bids;

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
    event BidPlaced(
        uint256 indexed bidId, address indexed buyer, bytes2 indexed country,
        uint256 amountKg, uint256 pricePerTonne, uint256 minFillKg
    );
    event BidFilled(
        uint256 indexed bidId, address indexed seller, uint256 indexed batchId,
        uint256 amountKg, uint256 cost, uint256 fee
    );
    event BidCancelled(uint256 indexed bidId, uint256 refunded);
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
    error BidInactive(uint256 bidId);
    error NotBuyer();
    error CountryMismatch(bytes2 wanted, bytes2 got);
    error CannotFillOwnBid();

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
        nextBidId = 1;
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

    // ───────────────────────── 買單 ─────────────────────────

    /// @notice 掛買單：指定核發國與價格，把錢鎖進本合約等人來賣。
    /// @param country 想買哪一國核發的額度；0x0000 表示不限。
    /// @dev 錢先收進來，不是等成交才跟買方拿。買單是對市場的承諾，
    ///      承諾要有擔保——否則掛單簿上會充滿付不出錢的買單，賣方看得到吃不到。
    ///      這跟賣單那一側是對稱的：賣單也是先把額度轉進合約託管。
    function placeBid(bytes2 country, uint256 amountKg, uint256 pricePerTonne, uint256 minFillKg)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 bidId)
    {
        if (amountKg == 0) revert ZeroAmount();
        if (!kyc.isActive(msg.sender)) revert NotActiveAccount(msg.sender);
        bidId = nextBidId++;
        uint256 escrow = amountKg * pricePerTonne / KG_PER_TONNE;
        _bids[bidId] = Bid({
            buyer: msg.sender,
            country: country,
            remainingKg: amountKg,
            pricePerTonne: pricePerTonne,
            minFillKg: minFillKg,
            active: true,
            escrow: escrow
        });
        settlementToken.safeTransferFrom(msg.sender, address(this), escrow);
        emit BidPlaced(bidId, msg.sender, country, amountKg, pricePerTonne, minFillKg);
    }

    /// @notice 持有人把手上的批次賣給某一張買單。
    /// @dev 手續費由**賣方**承擔，跟 `buy()` 同一套規則——同一筆交易不該因為
    ///      誰先掛單而收不同的費。
    function fillBid(uint256 bidId, uint256 batchId, uint256 amountKg) external nonReentrant whenNotPaused {
        Bid storage b = _bids[bidId];
        if (!b.active) revert BidInactive(bidId);
        if (b.buyer == msg.sender) revert CannotFillOwnBid();
        if (!kyc.isActive(msg.sender)) revert NotActiveAccount(msg.sender);
        if (amountKg == 0) revert ZeroAmount();
        if (amountKg > b.remainingKg) revert ExceedsRemaining();
        if (amountKg < b.minFillKg && amountKg != b.remainingKg) revert BelowMinFill();

        uint256 projectId = credit.batchOf(batchId).projectId;
        // 轄區關掉之後不能再上架，買單這一側同理。
        IJurisdictions(credit.registry()).checkTradable(projectId);
        if (b.country != bytes2(0)) {
            (bytes2 got,) = IJurisdictions(credit.registry()).jurisdictionOfProject(projectId);
            if (got != b.country) revert CountryMismatch(b.country, got);
        }

        uint256 cost = amountKg * b.pricePerTonne / KG_PER_TONNE;
        uint256 fee = cost * feeBpsOf(batchId) / 10_000;

        b.remainingKg -= amountKg;
        b.escrow -= cost;
        uint256 dust;
        if (b.remainingKg == 0) {
            b.active = false;
            // 全部成交了，捨去的餘數退還買方——留在合約裡就沒有人領得走了
            dust = b.escrow;
            b.escrow = 0;
        }

        // 錢從託管付出去；額度由賣方直接轉給買方（白名單在 _update 檢查雙方，
        // 買方若已失效或被凍結，這一步會 revert——規則只寫在身分層那一處）。
        settlementToken.safeTransfer(msg.sender, cost - fee);
        if (fee > 0) settlementToken.safeTransfer(treasury, fee);
        if (dust > 0) settlementToken.safeTransfer(b.buyer, dust);
        credit.safeTransferFrom(msg.sender, b.buyer, batchId, amountKg, "");

        emit BidFilled(bidId, msg.sender, batchId, amountKg, cost, fee);
    }

    /// @notice 取消買單，退回剩下的託管款。
    /// @dev 不檢查 KYC：那是買方自己的錢，身分過期也該拿得回去。
    function cancelBid(uint256 bidId) external nonReentrant {
        Bid storage b = _bids[bidId];
        if (!b.active) revert BidInactive(bidId);
        if (b.buyer != msg.sender && !hasRole(OPERATOR_ROLE, msg.sender)) revert NotBuyer();
        // 退還「實際還鎖著的」，不是用剩餘數量乘回去——兩者會差一點捨去的餘數
        uint256 refund = b.escrow;
        b.active = false;
        b.remainingKg = 0;
        b.escrow = 0;
        settlementToken.safeTransfer(b.buyer, refund);
        emit BidCancelled(bidId, refund);
    }

    function bidOf(uint256 bidId) external view returns (Bid memory) {
        return _bids[bidId];
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
