// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IKYCRegistry} from "../interfaces/IKYCRegistry.sol";
import {IJurisdictions} from "../interfaces/IJurisdictions.sol";
import {IRecoverable} from "../interfaces/IRecoverable.sol";
import {RetirementCertificate} from "./RetirementCertificate.sol";

interface IFeeSchedule {
    function collectRetireFee(address payer, bytes2 country, uint256 amountKg) external returns (uint256);
}

/// @title CarbonCredit1155
/// @notice 減量額度本體（ERC-1155，不可升級）。每個 tokenId 是一個核發批次（專案 + 監測期間）。
///         單位：1 = 1 kgCO2e；1 噸 = 1000。
///
/// 白名單主防線在這裡的 _update：
///   - mint（核發）：收件人須為有效身分（CarbonRegistry 已確認為專案擁有者）
///   - burn（註銷）：見 retire()；不經 checkTransfer
///   - transfer：雙方須有效且未凍結；自然人轉出需政策開啟；批次未凍結
///
/// 依賴 KYCRegistry 的 proxy 地址（immutable），政策變動不影響本合約。
contract CarbonCredit1155 is ERC1155, AccessControl, IRecoverable {
    using EnumerableSet for EnumerableSet.UintSet;

    bytes32 public constant SOVEREIGN_ROLE = keccak256("SOVEREIGN_ROLE");

    struct Batch {
        uint256 projectId;
        uint64 monitoringStart;
        uint64 monitoringEnd;
        uint16 vintageYear; // 池化分年依據，取監測期間結束年
        bytes32 serialHash; // 官方序號段 hash（全域唯一，由 CarbonRegistry 保證）
        bytes32 reportHash; // 查驗報告 hash
        address verifier; // 查驗機構
        uint64 issuedAt;
        uint256 issuedKg;
        uint256 retiredKg;
        bool frozen;
    }

    IKYCRegistry public immutable kyc;
    RetirementCertificate public immutable certificate;
    address public registry; // CarbonRegistry，一次性設定
    /// @dev 各國費率表。為 0 時不收註銷手續費（Phase 0 預設如此）。
    ///      本合約不可升級，所以費率邏輯放在外部合約，由主權角色換掉；
    ///      額度本身的規則留在這裡，費率那種會變的東西不該綁死在不可升級的合約裡。
    address public feeSchedule;

    uint256 public nextBatchId = 1;
    mapping(uint256 => Batch) private _batches;
    mapping(address => EnumerableSet.UintSet) private _held;

    event BatchIssued(
        uint256 indexed batchId, uint256 indexed projectId, address indexed to, uint256 amountKg, bytes32 serialHash
    );
    event BatchFrozen(uint256 indexed batchId, bool frozen);
    event CreditRetired(
        uint256 indexed batchId,
        address indexed holder,
        address indexed certificateOwner,
        uint256 amountKg,
        uint256 certId
    );
    event RegistrySet(address indexed registry);
    event FeeScheduleSet(address indexed feeSchedule);
    event BalancesRecovered(address indexed from, address indexed to, uint256 batches);

    error OnlyRegistry();
    error OnlyKYC();
    error RegistryAlreadySet();
    error ZeroAddress();
    error BatchIsFrozen(uint256 batchId);
    error NotAuthorized();
    error UnknownBatch(uint256 batchId);

    constructor(
        address admin,
        address sovereign,
        IKYCRegistry kyc_,
        RetirementCertificate certificate_,
        string memory uri_
    ) ERC1155(uri_) {
        kyc = kyc_;
        certificate = certificate_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SOVEREIGN_ROLE, sovereign);
    }

    // ───────────────────────── 設定 ─────────────────────────

    function setRegistry(address registry_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (registry != address(0)) revert RegistryAlreadySet();
        if (registry_ == address(0)) revert ZeroAddress();
        registry = registry_;
        emit RegistrySet(registry_);
    }

    function setFeeSchedule(address feeSchedule_) external onlyRole(SOVEREIGN_ROLE) {
        feeSchedule = feeSchedule_;
        emit FeeScheduleSet(feeSchedule_);
    }

    function setBatchFrozen(uint256 batchId, bool frozen) external onlyRole(SOVEREIGN_ROLE) {
        if (batchId == 0 || batchId >= nextBatchId) revert UnknownBatch(batchId);
        _batches[batchId].frozen = frozen;
        emit BatchFrozen(batchId, frozen);
    }

    // ───────────────────────── 核發 ─────────────────────────

    /// @notice 只有 CarbonRegistry 可呼叫；查驗簽章、序號唯一性都在 Registry 檢查。
    function issue(address to, Batch memory b) external returns (uint256 batchId) {
        if (msg.sender != registry) revert OnlyRegistry();
        batchId = nextBatchId++;
        b.issuedAt = uint64(block.timestamp);
        b.retiredKg = 0;
        b.frozen = false;
        _batches[batchId] = b;
        _mint(to, batchId, b.issuedKg, "");
        emit BatchIssued(batchId, b.projectId, to, b.issuedKg, b.serialHash);
    }

    // ───────────────────────── 註銷 ─────────────────────────

    struct RetireRequest {
        address holder; // msg.sender 或已授權 msg.sender 的帳戶（例如 CarbonPool 代為註銷）
        uint256 batchId;
        uint256 amountKg;
        address certificateTo; // 憑證收件人（需為已知身分，供申報對應）
        bytes32 beneficiaryHash;
        string beneficiary;
        RetirementCertificate.Purpose purpose;
        string memo;
    }

    /// @notice 註銷：burn 額度並產生憑證。
    function retire(RetireRequest calldata r) external returns (uint256 certId) {
        if (r.holder != msg.sender && !isApprovedForAll(r.holder, msg.sender)) revert NotAuthorized();
        Batch storage b = _batches[r.batchId];
        if (b.issuedKg == 0) revert UnknownBatch(r.batchId);
        if (b.frozen) revert BatchIsFrozen(r.batchId);
        kyc.checkRetire(r.certificateTo);
        // 用途 × 轄區：國外額度不能拿來做增量抵換或環評承諾（氣候變遷因應法第 27 條）。
        // 擋在這裡而不是只在介面提示——一張主張了不合法用途的憑證，比沒有憑證更糟。
        IJurisdictions(registry).checkRetirePurpose(b.projectId, uint8(r.purpose));

        // 註銷手續費：依核發國費率，向**憑證收件人**收取（池化路徑的呼叫者是池合約，它沒有錢，
        // 而且拿到憑證的人才是這次代辦服務的受益人）。費率為 0 就什麼都不會發生。
        if (feeSchedule != address(0)) {
            (bytes2 country,) = IJurisdictions(registry).jurisdictionOfProject(b.projectId);
            IFeeSchedule(feeSchedule).collectRetireFee(r.certificateTo, country, r.amountKg);
        }

        _burn(r.holder, r.batchId, r.amountKg);
        b.retiredKg += r.amountKg;

        certId = certificate.mint(r.certificateTo, _toCertificate(r, b.projectId));
        emit CreditRetired(r.batchId, r.holder, r.certificateTo, r.amountKg, certId);
    }

    function _toCertificate(RetireRequest calldata r, uint256 projectId)
        internal
        view
        returns (RetirementCertificate.Certificate memory c)
    {
        (bytes2 country, IJurisdictions.Jurisdiction memory j) = IJurisdictions(registry).jurisdictionOfProject(projectId);
        c.country = country;
        c.scheme = j.scheme;
        c.batchId = r.batchId;
        c.amountKg = r.amountKg;
        c.beneficiaryHash = r.beneficiaryHash;
        c.beneficiary = r.beneficiary;
        c.purpose = r.purpose;
        c.memo = r.memo;
        c.retiredBy = r.holder;
        c.retiredAt = uint64(block.timestamp);
    }

    // ───────────────────────── 復原 ─────────────────────────

    function recoverBalances(address from, address to) external {
        if (msg.sender != address(kyc)) revert OnlyKYC();
        uint256[] memory ids = _held[from].values();
        uint256 n = ids.length;
        uint256[] memory amounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            amounts[i] = balanceOf(from, ids[i]);
        }
        if (n > 0) _recovering = true;
        _update(from, to, ids, amounts);
        _recovering = false;
        emit BalancesRecovered(from, to, n);
    }

    bool private _recovering;

    // ───────────────────────── 查詢 ─────────────────────────

    function batchOf(uint256 batchId) external view returns (Batch memory) {
        if (batchId == 0 || batchId >= nextBatchId) revert UnknownBatch(batchId);
        return _batches[batchId];
    }

    function heldBatches(address account) external view returns (uint256[] memory) {
        return _held[account].values();
    }

    // ───────────────────────── 白名單 ─────────────────────────

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (from != address(0) && to != address(0) && !_recovering) {
            kyc.checkTransfer(from, to);
            for (uint256 i = 0; i < ids.length; i++) {
                if (_batches[ids[i]].frozen) revert BatchIsFrozen(ids[i]);
            }
        }
        super._update(from, to, ids, values);
        for (uint256 i = 0; i < ids.length; i++) {
            if (from != address(0) && balanceOf(from, ids[i]) == 0) _held[from].remove(ids[i]);
            if (to != address(0) && values[i] > 0) _held[to].add(ids[i]);
        }
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
