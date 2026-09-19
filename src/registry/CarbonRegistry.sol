// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IKYCRegistry} from "../interfaces/IKYCRegistry.sol";
import {CarbonCredit1155} from "./CarbonCredit1155.sol";

/// @title CarbonRegistry
/// @notice 登錄簿（不可升級）。平台即登錄處：不橋接外部註冊處。
///
/// 流程：減量企業登錄專案 → 完成 ISO 14064-2 減量、14064-3 查驗 →
///       查驗機構（VERIFIER_ROLE，由主權角色認可）簽發 EIP-712 IssuanceAttestation →
///       任何人提交 issue() → 驗簽、序號唯一 → CarbonCredit1155 核發批次給專案擁有者。
contract CarbonRegistry is AccessControl, EIP712 {
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

    uint256 public nextProjectId = 1;
    mapping(uint256 => Project) private _projects;
    mapping(bytes32 => bool) public serialUsed;
    mapping(address => mapping(uint256 => bool)) public attestationUsed; // verifier => attestationId

    event ProjectRegistered(uint256 indexed projectId, address indexed owner, string name, string methodology);
    event ProjectStatus(uint256 indexed projectId, bool active);
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

    constructor(address admin, address sovereign, IKYCRegistry kyc_, CarbonCredit1155 credit_)
        EIP712("CO2Exchange CarbonRegistry", "1")
    {
        kyc = kyc_;
        credit = credit_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SOVEREIGN_ROLE, sovereign);
        _setRoleAdmin(VERIFIER_ROLE, SOVEREIGN_ROLE);
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
        projectId = nextProjectId++;
        _projects[projectId] = Project({
            owner: msg.sender,
            name: name,
            methodology: methodology,
            location: location,
            metadataURI: metadataURI,
            active: true
        });
        emit ProjectRegistered(projectId, msg.sender, name, methodology);
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
