// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FeeSchedule
/// @notice 費率表：交易手續費與註銷手續費，**每個轄區可以各自設定**。
///
/// 為什麼要分國家：各國登錄簿的作業成本不一樣。日本的移轉要走另一套申請、
/// 泰國的登錄簿要另外開戶、澳洲的 ANREU 有自己的程序——把這些成本壓成一個
/// 全球單一費率，不是比較公平，是比較懶：跨境成本低的轄區在補貼成本高的轄區。
///
/// 兩種費率的單位刻意不同：
///   - **交易手續費**用 bps（成交金額的比例）。成交金額當下就知道，比例最直覺。
///   - **註銷手續費**用「每公噸固定金額」。註銷的成本是代辦一次官方移轉與註銷申請，
///     那是按件與按量計費的行政工作，跟當天的市價一點關係也沒有。
///     用比例收費會出現「市價漲了、辦同一件事卻要多收錢」這種說不出道理的結果。
///
/// 沒有設定的轄區走預設值。設了之後可以再清掉，回到預設值。
contract FeeSchedule is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant SOVEREIGN_ROLE = keccak256("SOVEREIGN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    /// @dev 調費率的服務金鑰（管理後台用）。由 OPERATOR（營運 Safe）授予與撤銷。
    bytes32 public constant PRICING_ROLE = keccak256("PRICING_ROLE");
    /// @dev 有權要求本合約向使用者收取註銷手續費的合約（CarbonCredit1155）。
    bytes32 public constant COLLECTOR_ROLE = keccak256("COLLECTOR_ROLE");

    /// @dev 交易手續費上限 5%。費率是營運參數，但不該能被調成掠奪性的數字。
    uint16 public constant MAX_TRADE_BPS = 500;

    struct CountryFee {
        bool set;
        uint16 tradeBps;
        uint256 retireFeePerTonne; // 結算幣最小單位 / 公噸
    }

    IERC20 public immutable settlement;
    address public treasury;
    uint16 public defaultTradeBps;
    uint256 public defaultRetireFeePerTonne;

    mapping(bytes2 => CountryFee) private _fees;
    bytes2[] private _countries;

    event DefaultsUpdated(uint16 tradeBps, uint256 retireFeePerTonne);
    event CountryFeeUpdated(bytes2 indexed country, bool set, uint16 tradeBps, uint256 retireFeePerTonne);
    event TreasuryUpdated(address treasury);
    event RetireFeeCollected(address indexed payer, bytes2 indexed country, uint256 amountKg, uint256 fee);

    error FeeTooHigh(uint16 bps);
    error ZeroAddress();

    constructor(
        address admin,
        address sovereign,
        address operator,
        IERC20 settlement_,
        address treasury_,
        uint16 defaultTradeBps_,
        uint256 defaultRetireFeePerTonne_
    ) {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (defaultTradeBps_ > MAX_TRADE_BPS) revert FeeTooHigh(defaultTradeBps_);
        settlement = settlement_;
        treasury = treasury_;
        defaultTradeBps = defaultTradeBps_;
        defaultRetireFeePerTonne = defaultRetireFeePerTonne_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SOVEREIGN_ROLE, sovereign);
        _grantRole(OPERATOR_ROLE, operator);
        _setRoleAdmin(OPERATOR_ROLE, SOVEREIGN_ROLE);
        _setRoleAdmin(PRICING_ROLE, OPERATOR_ROLE);
        _setRoleAdmin(COLLECTOR_ROLE, SOVEREIGN_ROLE);
    }

    // ───────────────────────── 設定 ─────────────────────────

    function setDefaults(uint16 tradeBps, uint256 retireFeePerTonne) external onlyRole(PRICING_ROLE) {
        if (tradeBps > MAX_TRADE_BPS) revert FeeTooHigh(tradeBps);
        defaultTradeBps = tradeBps;
        defaultRetireFeePerTonne = retireFeePerTonne;
        emit DefaultsUpdated(tradeBps, retireFeePerTonne);
    }

    /// @notice 設定或清除單一轄區的費率。set = false 代表回到預設值。
    function setCountryFee(bytes2 country, bool set, uint16 tradeBps, uint256 retireFeePerTonne)
        external
        onlyRole(PRICING_ROLE)
    {
        if (set && tradeBps > MAX_TRADE_BPS) revert FeeTooHigh(tradeBps);
        if (!_fees[country].set && set) _countries.push(country);
        _fees[country] = CountryFee({set: set, tradeBps: tradeBps, retireFeePerTonne: retireFeePerTonne});
        emit CountryFeeUpdated(country, set, tradeBps, retireFeePerTonne);
    }

    function setTreasury(address treasury_) external onlyRole(SOVEREIGN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    // ───────────────────────── 查詢 ─────────────────────────

    function tradeBpsOf(bytes2 country) public view returns (uint16) {
        CountryFee memory f = _fees[country];
        return f.set ? f.tradeBps : defaultTradeBps;
    }

    function retireFeePerTonneOf(bytes2 country) public view returns (uint256) {
        CountryFee memory f = _fees[country];
        return f.set ? f.retireFeePerTonne : defaultRetireFeePerTonne;
    }

    function retireFeeFor(bytes2 country, uint256 amountKg) public view returns (uint256) {
        return (retireFeePerTonneOf(country) * amountKg) / 1000;
    }

    function countryFeeOf(bytes2 country) external view returns (CountryFee memory) {
        return _fees[country];
    }

    /// @notice 有設過專屬費率的轄區清單（清掉的也還在陣列裡，用 countryFeeOf 判斷 set）。
    function configuredCountries() external view returns (bytes2[] memory) {
        return _countries;
    }

    // ───────────────────────── 收費 ─────────────────────────

    /// @notice 由 CarbonCredit1155 在註銷時呼叫。費率為 0 就什麼都不做。
    /// @dev 付款人是**憑證收件人**，不是呼叫者：池化路徑的呼叫者是池合約，它沒有錢，
    ///      而且拿到憑證的人才是這次服務的受益人。
    function collectRetireFee(address payer, bytes2 country, uint256 amountKg)
        external
        onlyRole(COLLECTOR_ROLE)
        returns (uint256 fee)
    {
        fee = retireFeeFor(country, amountKg);
        if (fee == 0) return 0;
        settlement.safeTransferFrom(payer, treasury, fee);
        emit RetireFeeCollected(payer, country, amountKg, fee);
    }
}
