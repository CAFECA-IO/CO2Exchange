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
import {IKYCRegistry} from "../interfaces/IKYCRegistry.sol";
import {CarbonCredit1155} from "../registry/CarbonCredit1155.sol";
import {RetirementCertificate} from "../registry/RetirementCertificate.sol";
import {CarbonCreditToken} from "./CarbonCreditToken.sol";

/// @title CarbonPool
/// @notice 同年份池：法人將 vintageYear 相符的 1155 批次存入，1:1 鑄出 CCT（1000 kg = 1e18）。
///         贖回預設 FIFO 免費；指定批次贖回收費（抑制逆選擇）。
///         redeemAndRetire 讓自然人一筆交易完成「CCT → 特定批次 → 註銷 → 憑證」。
contract CarbonPool is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    ERC1155HolderUpgradeable
{
    bytes32 public constant SOVEREIGN_ROLE = keccak256("SOVEREIGN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint256 public constant CCT_PER_KG = 1e15; // 1e18 / 1000
    uint256 public constant MAX_FEE_BPS = 2000;
    /// @dev 一次 FIFO 贖回最多跨越的批次數，避免小額批次過多時 gas 爆掉；超過請分次贖回
    uint256 public constant MAX_BATCHES_PER_REDEEM = 20;

    IKYCRegistry public kyc;
    CarbonCredit1155 public credit;
    CarbonCreditToken public cct;
    uint16 public vintageYear;
    uint256 public selectiveRedeemFeeBps;
    address public treasury;

    uint256[] private _queue; // FIFO 批次序列
    uint256 private _queueHead;
    mapping(uint256 => uint256) public pooledKg; // batchId => 池內存量

    event Deposited(address indexed from, uint256 indexed batchId, uint256 amountKg, uint256 cctMinted);
    event Redeemed(address indexed to, uint256 indexed batchId, uint256 amountKg, uint256 cctBurned, uint256 feeCct);
    event RedeemedAndRetired(address indexed account, uint256 indexed batchId, uint256 amountKg, uint256 certId);
    event FeeUpdated(uint256 feeBps, address treasury);

    error NotCorporate(address account);
    error NotActiveAccount(address account);
    error VintageMismatch(uint16 expected, uint16 actual);
    error BatchIsFrozen(uint256 batchId);
    error InsufficientPooled(uint256 batchId);
    error InsufficientLiquidity();
    error FeeTooHigh();
    error ZeroAmount();
    error ZeroAddress();
    error TooManyBatches(uint256 needed, uint256 max);

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
        CarbonCreditToken cct_,
        uint16 vintageYear_,
        uint256 selectiveRedeemFeeBps_,
        address treasury_
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
        cct = cct_;
        vintageYear = vintageYear_;
        if (selectiveRedeemFeeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (treasury_ == address(0)) revert ZeroAddress();
        selectiveRedeemFeeBps = selectiveRedeemFeeBps_;
        treasury = treasury_;
    }

    function setFee(uint256 feeBps_, address treasury_) external onlyRole(OPERATOR_ROLE) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (treasury_ == address(0)) revert ZeroAddress();
        selectiveRedeemFeeBps = feeBps_;
        treasury = treasury_;
        emit FeeUpdated(feeBps_, treasury_);
    }

    function pause() external {
        if (!hasRole(OPERATOR_ROLE, msg.sender) && !hasRole(SOVEREIGN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, OPERATOR_ROLE);
        }
        _pause();
    }

    function unpause() external onlyRole(OPERATOR_ROLE) {
        _unpause();
    }

    // ───────────────────────── 存入 ─────────────────────────

    function deposit(uint256 batchId, uint256 amountKg) external nonReentrant whenNotPaused {
        if (amountKg == 0) revert ZeroAmount();
        if (kyc.tierOf(msg.sender) != IKYCRegistry.Tier.Corporate || !kyc.isActive(msg.sender)) {
            revert NotCorporate(msg.sender);
        }
        CarbonCredit1155.Batch memory b = credit.batchOf(batchId);
        if (b.vintageYear != vintageYear) revert VintageMismatch(vintageYear, b.vintageYear);
        if (b.frozen) revert BatchIsFrozen(batchId);

        if (pooledKg[batchId] == 0) _queue.push(batchId);
        pooledKg[batchId] += amountKg;
        credit.safeTransferFrom(msg.sender, address(this), batchId, amountKg, "");
        uint256 minted = amountKg * CCT_PER_KG;
        cct.mint(msg.sender, minted);
        emit Deposited(msg.sender, batchId, amountKg, minted);
    }

    // ───────────────────────── 贖回 ─────────────────────────

    /// @notice FIFO 贖回，免費。回傳實際取得的批次與數量。
    function redeem(uint256 amountKg)
        external
        nonReentrant
        whenNotPaused
        returns (uint256[] memory ids, uint256[] memory amounts)
    {
        if (amountKg == 0) revert ZeroAmount();
        if (!kyc.isActive(msg.sender)) revert NotActiveAccount(msg.sender);
        (ids, amounts) = _takeFifo(amountKg);
        cct.burnFrom(msg.sender, amountKg * CCT_PER_KG);
        for (uint256 i = 0; i < ids.length; i++) {
            credit.safeTransferFrom(address(this), msg.sender, ids[i], amounts[i], "");
            emit Redeemed(msg.sender, ids[i], amounts[i], amounts[i] * CCT_PER_KG, 0);
        }
    }

    /// @notice 指定批次贖回，收取 selectiveRedeemFeeBps（以 CCT 計）。
    function redeemSpecific(uint256 batchId, uint256 amountKg) external nonReentrant whenNotPaused {
        if (amountKg == 0) revert ZeroAmount();
        if (!kyc.isActive(msg.sender)) revert NotActiveAccount(msg.sender);
        if (pooledKg[batchId] < amountKg) revert InsufficientPooled(batchId);
        uint256 cctAmount = amountKg * CCT_PER_KG;
        uint256 fee = cctAmount * selectiveRedeemFeeBps / 10_000;
        pooledKg[batchId] -= amountKg;
        // 贖回者需支付 cctAmount + fee；fee 轉入 treasury（先 burn 再 mint，總供給淨減 cctAmount，1:1 backing 不變）
        cct.burnFrom(msg.sender, cctAmount + fee);
        if (fee > 0) cct.mint(treasury, fee);
        credit.safeTransferFrom(address(this), msg.sender, batchId, amountKg, "");
        emit Redeemed(msg.sender, batchId, amountKg, cctAmount, fee);
    }

    /// @notice 一筆交易完成 CCT → FIFO 批次 → 註銷 → 憑證（自然人主要路徑，不需持有 1155）。
    function redeemAndRetire(
        uint256 amountKg,
        bytes32 beneficiaryHash,
        string calldata beneficiary,
        RetirementCertificate.Purpose purpose,
        string calldata memo
    ) external nonReentrant whenNotPaused returns (uint256[] memory certIds) {
        if (amountKg == 0) revert ZeroAmount();
        kyc.checkRetire(msg.sender);
        (uint256[] memory ids, uint256[] memory amounts) = _takeFifo(amountKg);
        cct.burnFrom(msg.sender, amountKg * CCT_PER_KG);
        certIds = new uint256[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            certIds[i] = credit.retire(
                CarbonCredit1155.RetireRequest({
                    holder: address(this),
                    batchId: ids[i],
                    amountKg: amounts[i],
                    certificateTo: msg.sender,
                    beneficiaryHash: beneficiaryHash,
                    beneficiary: beneficiary,
                    purpose: purpose,
                    memo: memo
                })
            );
            emit RedeemedAndRetired(msg.sender, ids[i], amounts[i], certIds[i]);
        }
    }

    // ───────────────────────── 內部 ─────────────────────────

    function _takeFifo(uint256 amountKg) internal returns (uint256[] memory ids, uint256[] memory amounts) {
        uint256 remaining = amountKg;
        uint256 head = _queueHead;
        uint256 count = 0;
        // 先數需要幾個批次
        for (uint256 i = head; i < _queue.length && remaining > 0; i++) {
            uint256 avail = pooledKg[_queue[i]];
            if (avail == 0) continue;
            count++;
            remaining = avail >= remaining ? 0 : remaining - avail;
        }
        if (remaining > 0) revert InsufficientLiquidity();
        if (count > MAX_BATCHES_PER_REDEEM) revert TooManyBatches(count, MAX_BATCHES_PER_REDEEM);

        ids = new uint256[](count);
        amounts = new uint256[](count);
        remaining = amountKg;
        uint256 k = 0;
        for (uint256 i = head; i < _queue.length && remaining > 0; i++) {
            uint256 id = _queue[i];
            uint256 avail = pooledKg[id];
            if (avail == 0) {
                if (i == _queueHead) _queueHead++;
                continue;
            }
            uint256 take = avail >= remaining ? remaining : avail;
            pooledKg[id] = avail - take;
            if (pooledKg[id] == 0 && i == _queueHead) _queueHead++;
            ids[k] = id;
            amounts[k] = take;
            k++;
            remaining -= take;
        }
    }

    function queueLength() external view returns (uint256) {
        return _queue.length - _queueHead;
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
