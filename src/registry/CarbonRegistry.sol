// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IKYCRegistry} from "../interfaces/IKYCRegistry.sol";
import {IJurisdictions} from "../interfaces/IJurisdictions.sol";
import {CarbonCredit1155} from "./CarbonCredit1155.sol";

/// @title CarbonRegistry
/// @notice 登錄簿（不可升級）。平台即登錄處：不橋接外部註冊處。
///
/// 流程：減量企業登錄專案 → 完成 ISO 14064-2 減量、14064-3 查驗 →
///       查驗機構（VERIFIER_ROLE，由主權角色認可）簽發 EIP-712 IssuanceAttestation →
///       任何人提交 issue() → 驗簽、序號唯一 → CarbonCredit1155 核發批次給專案擁有者。
contract CarbonRegistry is AccessControl, EIP712, IJurisdictions {
    bytes32 public constant SOVEREIGN_ROLE = keccak256("SOVEREIGN_ROLE");
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

    bytes32 public constant ISSUANCE_TYPEHASH = keccak256(
        "IssuanceAttestation(uint256 projectId,uint64 monitoringStart,uint64 monitoringEnd,uint256 amountKg,bytes32 serialHash,bytes32 reportHash,uint256 attestationId,uint256 deadline)"
    );

    struct Project {
        address owner;
        string name;
        string methodology; // 例如 "ISO 14064-2 / 環境部 方法學代碼"
        string location;
        string metadataURI;
        bool active;
        /// @dev 核發國／轄區，ISO 3166-1 alpha-2，例如 "TW"、"JP"。決定這批額度能拿來做什麼。
        bytes2 country;
        /// @dev 該轄區的減量機制名稱，例如 "TCER"、"J-Credit"。同一國可能有多套機制。
        string scheme;
    }

    struct IssuanceAttestation {
        uint256 projectId;
        uint64 monitoringStart;
        uint64 monitoringEnd;
        uint256 amountKg;
        bytes32 serialHash;
        bytes32 reportHash;
        uint256 attestationId;
        uint256 deadline;
    }

    IKYCRegistry public immutable kyc;
    CarbonCredit1155 public immutable credit;

    /// @dev 本站的母國。國內額度＝臺灣核發的額度，法規上與國外額度是兩套規則。
    bytes2 public constant DOMESTIC = "TW";

    uint256 public nextProjectId = 1;
    mapping(uint256 => Project) private _projects;
    mapping(bytes2 => Jurisdiction) private _jurisdictions;
    bytes2[] private _countries;
    mapping(bytes32 => bool) public serialUsed;
    mapping(address => mapping(uint256 => bool)) public attestationUsed; // verifier => attestationId

    event ProjectRegistered(uint256 indexed projectId, address indexed owner, string name, string methodology);
    event ProjectStatus(uint256 indexed projectId, bool active);
    event JurisdictionSet(bytes2 indexed country, bool enabled, bool domestic, uint8 purposeMask, string scheme);
    event ProjectJurisdiction(uint256 indexed projectId, bytes2 indexed country, string scheme);
    event CreditsIssued(
        uint256 indexed projectId,
        uint256 indexed batchId,
        address indexed verifier,
        uint256 amountKg,
        bytes32 serialHash,
        bytes32 reportHash
    );

    error NotCorporate(address account);
    error UnknownProject(uint256 projectId);
    error ProjectInactive(uint256 projectId);
    error SerialAlreadyUsed(bytes32 serialHash);
    error AttestationAlreadyUsed(uint256 attestationId);
    error InvalidAttestation();
    error AttestationExpired();
    error InvalidPeriod();
    error UnknownJurisdiction(bytes2 country);
    error JurisdictionDisabled(bytes2 country);
    error PurposeNotAllowed(bytes2 country, uint8 purpose);

    constructor(address admin, address sovereign, IKYCRegistry kyc_, CarbonCredit1155 credit_)
        EIP712("CO2Exchange CarbonRegistry", "1")
    {
        kyc = kyc_;
        credit = credit_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SOVEREIGN_ROLE, sovereign);
        _setRoleAdmin(VERIFIER_ROLE, SOVEREIGN_ROLE);
        // 母國一開始就在，而且四種用途全開：本站的預設仍然是國內額度。
        // 其他轄區要由主權角色一個一個開，不會因為部署就自動存在。
        _setJurisdiction(
            DOMESTIC,
            Jurisdiction({
                enabled: true,
                domestic: true,
                purposeMask: 0x0F,
                name: unicode"臺灣",
                scheme: "TCER",
                registryName: unicode"溫室氣體減量額度管理系統",
                note: unicode"國內減量額度，四種用途皆可；碳費扣除上限為收費排放量 10%，自願減量專案額度扣除比率 1.2"
            })
        );
    }

    // ───────────────────────── 轄區 ─────────────────────────

    /// @notice 開啟／調整一個轄區。purposeMask 是 RetirementCertificate.Purpose 的 bitmask。
    /// @dev 國外額度的 mask 應只含 CarbonFee（1<<0）與 VoluntaryNeutrality（1<<1）：
    ///      氣候變遷因應法第 27 條只讓國外額度用於扣除碳費排放量與抵銷超額量，
    ///      增量抵換（第 24 條）與環評承諾都是國內額度才做得到的事。
    function setJurisdiction(bytes2 country, Jurisdiction calldata j) external onlyRole(SOVEREIGN_ROLE) {
        _setJurisdiction(country, j);
    }

    function _setJurisdiction(bytes2 country, Jurisdiction memory j) internal {
        if (bytes(_jurisdictions[country].name).length == 0) _countries.push(country);
        _jurisdictions[country] = j;
        emit JurisdictionSet(country, j.enabled, j.domestic, j.purposeMask, j.scheme);
    }

    function jurisdictionOf(bytes2 country) external view returns (Jurisdiction memory) {
        Jurisdiction memory j = _jurisdictions[country];
        if (bytes(j.name).length == 0) revert UnknownJurisdiction(country);
        return j;
    }

    function countries() external view returns (bytes2[] memory) {
        return _countries;
    }

    function jurisdictionOfProject(uint256 projectId) public view returns (bytes2, Jurisdiction memory) {
        Project memory p = _projects[projectId];
        if (p.owner == address(0)) revert UnknownProject(projectId);
        return (p.country, _jurisdictions[p.country]);
    }

    function checkRetirePurpose(uint256 projectId, uint8 purpose) external view {
        (bytes2 c, Jurisdiction memory j) = jurisdictionOfProject(projectId);
        if (bytes(j.name).length == 0) revert UnknownJurisdiction(c);
        if (purpose > 7 || (j.purposeMask & uint8(1 << purpose)) == 0) revert PurposeNotAllowed(c, purpose);
    }

    function checkTradable(uint256 projectId) external view {
        (bytes2 c, Jurisdiction memory j) = jurisdictionOfProject(projectId);
        if (bytes(j.name).length == 0) revert UnknownJurisdiction(c);
        if (!j.enabled) revert JurisdictionDisabled(c);
    }

    // ───────────────────────── 查驗機構 ─────────────────────────

    function approveVerifier(address verifier) external onlyRole(SOVEREIGN_ROLE) {
        _grantRole(VERIFIER_ROLE, verifier);
    }

    function revokeVerifier(address verifier) external onlyRole(SOVEREIGN_ROLE) {
        _revokeRole(VERIFIER_ROLE, verifier);
    }

    // ───────────────────────── 專案 ─────────────────────────

    function registerProject(
        string calldata name,
        string calldata methodology,
        string calldata location,
        string calldata metadataURI
    ) external returns (uint256 projectId) {
        if (kyc.tierOf(msg.sender) != IKYCRegistry.Tier.Corporate || !kyc.isActive(msg.sender)) {
            revert NotCorporate(msg.sender);
        }
        projectId = _register(msg.sender, name, methodology, location, metadataURI, DOMESTIC, "TCER");
    }

    /// @notice 由主權角色登錄「本站自國外登錄簿引入」的專案。
    /// @dev 國別不是自己說了算的事：它決定這批額度在臺灣能不能拿來申報。
    ///      所以國內專案走 registerProject（一律 TW），國外額度只能由主權角色依國外登錄簿的紀錄登錄。
    function registerImportedProject(
        address owner,
        string calldata name,
        string calldata methodology,
        string calldata location,
        string calldata metadataURI,
        bytes2 country,
        string calldata scheme
    ) external onlyRole(SOVEREIGN_ROLE) returns (uint256 projectId) {
        Jurisdiction memory j = _jurisdictions[country];
        if (bytes(j.name).length == 0) revert UnknownJurisdiction(country);
        if (!j.enabled) revert JurisdictionDisabled(country);
        projectId = _register(owner, name, methodology, location, metadataURI, country, scheme);
    }

    function _register(
        address owner,
        string calldata name,
        string calldata methodology,
        string calldata location,
        string calldata metadataURI,
        bytes2 country,
        string memory scheme
    ) internal returns (uint256 projectId) {
        projectId = nextProjectId++;
        _projects[projectId] = Project({
            owner: owner,
            name: name,
            methodology: methodology,
            location: location,
            metadataURI: metadataURI,
            active: true,
            country: country,
            scheme: scheme
        });
        emit ProjectRegistered(projectId, owner, name, methodology);
        emit ProjectJurisdiction(projectId, country, scheme);
    }

    function setProjectActive(uint256 projectId, bool active) external onlyRole(SOVEREIGN_ROLE) {
        if (_projects[projectId].owner == address(0)) revert UnknownProject(projectId);
        _projects[projectId].active = active;
        emit ProjectStatus(projectId, active);
    }

    function projectOf(uint256 projectId) external view returns (Project memory) {
        if (_projects[projectId].owner == address(0)) revert UnknownProject(projectId);
        return _projects[projectId];
    }

    // ───────────────────────── 核發 ─────────────────────────

    function issue(IssuanceAttestation calldata a, bytes calldata signature) external returns (uint256 batchId) {
        Project memory p = _projects[a.projectId];
        if (p.owner == address(0)) revert UnknownProject(a.projectId);
        if (!p.active) revert ProjectInactive(a.projectId);
        if (block.timestamp > a.deadline) revert AttestationExpired();
        if (a.monitoringEnd <= a.monitoringStart) revert InvalidPeriod();
        if (serialUsed[a.serialHash]) revert SerialAlreadyUsed(a.serialHash);

        address verifier = ECDSA.recover(_hashIssuance(a), signature);
        if (!hasRole(VERIFIER_ROLE, verifier)) revert InvalidAttestation();
        if (attestationUsed[verifier][a.attestationId]) revert AttestationAlreadyUsed(a.attestationId);

        serialUsed[a.serialHash] = true;
        attestationUsed[verifier][a.attestationId] = true;

        batchId = credit.issue(
            p.owner,
            CarbonCredit1155.Batch({
                projectId: a.projectId,
                monitoringStart: a.monitoringStart,
                monitoringEnd: a.monitoringEnd,
                vintageYear: _yearOf(a.monitoringEnd),
                serialHash: a.serialHash,
                reportHash: a.reportHash,
                verifier: verifier,
                issuedAt: 0,
                issuedKg: a.amountKg,
                retiredKg: 0,
                frozen: false
            })
        );
        emit CreditsIssued(a.projectId, batchId, verifier, a.amountKg, a.serialHash, a.reportHash);
    }

    function hashIssuance(IssuanceAttestation calldata a) external view returns (bytes32) {
        return _hashIssuance(a);
    }

    function _hashIssuance(IssuanceAttestation calldata a) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ISSUANCE_TYPEHASH,
                    a.projectId,
                    a.monitoringStart,
                    a.monitoringEnd,
                    a.amountKg,
                    a.serialHash,
                    a.reportHash,
                    a.attestationId,
                    a.deadline
                )
            )
        );
    }

    /// @dev 由 unix timestamp 取西元年（civil-from-days，Howard Hinnant 演算法）
    function _yearOf(uint64 ts) internal pure returns (uint16) {
        int256 z = int256(uint256(ts)) / 86400 + 719468;
        int256 era = (z >= 0 ? z : z - 146096) / 146097;
        int256 doe = z - era * 146097;
        int256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        int256 y = yoe + era * 400;
        int256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        int256 mp = (5 * doy + 2) / 153;
        int256 m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
        return uint16(uint256(y));
    }
}
