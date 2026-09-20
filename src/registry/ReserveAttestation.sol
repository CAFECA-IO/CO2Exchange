// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ReserveAttestation
/// @notice 託管與準備金的定期揭露（不可升級）。
///
/// 本站不自己保管碳權，也不自己保管錢：
///   - **碳權**託管在各國政府的官方登錄簿帳戶裡（臺灣＝環境部溫室氣體減量額度管理系統的額度帳戶，
///     日本＝Ｊ－クレジット登録簿，依此類推）。鏈上的每一公噸，都要對得到某一國登錄簿裡的一公噸。
///   - **入金**託管在信託機構的信託專戶裡，與本站自有資金分離。鏈上結算幣的發行量，
///     要對得到信託專戶裡的餘額。
///
/// 「對得到」這件事不能只是口頭承諾，所以每個月 5 日發布一份對帳報告上鏈：
/// 每個轄區託管帳戶裡有多少、鏈上流通多少、差異多少；信託專戶有多少、鏈上發行多少。
/// 報告全文（PDF）的 hash 一併寫上來，任何人都可以重算比對。
///
/// 誰能發布：OPERATOR_ROLE（營運 Safe）建立與更新報告；AUDITOR_ROLE（外部查核機構）簽署定稿。
/// 定稿之後不可修改——要更正只能發新的一份，舊的留著。這是揭露，不是可以事後改寫的公告欄。
contract ReserveAttestation is AccessControl {
    bytes32 public constant SOVEREIGN_ROLE = keccak256("SOVEREIGN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    /// @dev 報表服務金鑰：只能發布報告與回寫文件 hash，不能簽核。由 OPERATOR（營運 Safe）授予。
    ///      與憑證 PDF 的 DOCUMENT_ROLE 同一個設計——治理角色在 Safe 手上，日常服務用可撤銷的小鑰匙。
    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");

    enum Status {
        Draft, // 營運方已填報，尚未經查核
        Attested, // 查核機構已簽署，數字相符
        Discrepancy // 查核機構已簽署，但有差異（差異金額與說明見 note）
    }

    /// @notice 一個轄區的碳權託管對帳。
    struct CreditReserve {
        bytes2 country; // ISO 3166-1 alpha-2
        string custodian; // 託管機關／登錄簿，例如 "環境部 溫室氣體減量額度管理系統"
        string accountRef; // 帳戶識別（可遮罩），例如 "TW-ACC-0001"
        uint256 heldKg; // 該國登錄簿帳戶內實際持有（kgCO2e）
        uint256 onchainKg; // 本站鏈上該轄區流通量（kgCO2e）
        bytes32 statementHash; // 登錄簿餘額證明文件 hash
    }

    /// @notice 入金的信託對帳。
    struct CashReserve {
        string trustee; // 信託機構名稱
        string accountRef; // 信託專戶識別（可遮罩）
        uint256 balance; // 信託專戶餘額（結算幣最小單位）
        uint256 tokenSupply; // 鏈上結算幣發行量（最小單位）
        bytes32 statementHash; // 信託對帳單 hash
    }

    struct Report {
        uint32 period; // 揭露期別 YYYYMM
        uint64 asOf; // 對帳基準日
        uint64 publishedAt;
        uint64 attestedAt;
        address publisher;
        address auditor;
        string auditorName;
        Status status;
        string note; // 差異說明；沒有差異時可留空
        bytes32 documentHash; // 報告全文 PDF 的 SHA-256
    }

    uint256 public nextReportId = 1;
    mapping(uint256 => Report) private _reports;
    mapping(uint256 => CreditReserve[]) private _credits;
    mapping(uint256 => CashReserve) private _cash;
    /// @dev 期別 → reportId。同一期別只留最新的一份指標，但舊的 report 本身不會消失。
    mapping(uint32 => uint256) public reportOfPeriod;
    uint32[] private _periods;

    event ReportPublished(uint256 indexed reportId, uint32 indexed period, uint64 asOf, address indexed publisher);
    event ReportAttested(uint256 indexed reportId, address indexed auditor, Status status, string note);
    event ReportDocument(uint256 indexed reportId, bytes32 documentHash);

    error AlreadyAttested(uint256 reportId);
    error UnknownReport(uint256 reportId);
    error EmptyReport();

    constructor(address admin, address sovereign, address operator) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SOVEREIGN_ROLE, sovereign);
        _grantRole(OPERATOR_ROLE, operator);
        _setRoleAdmin(OPERATOR_ROLE, SOVEREIGN_ROLE);
        // 查核機構由主權角色認可；報表金鑰由營運端自行管理與輪替。
        _setRoleAdmin(AUDITOR_ROLE, SOVEREIGN_ROLE);
        _setRoleAdmin(REPORTER_ROLE, OPERATOR_ROLE);
    }

    /// @notice 發布一期對帳報告（草稿狀態）。
    function publish(uint32 period, uint64 asOf, CreditReserve[] calldata credits, CashReserve calldata cash)
        external
        onlyRole(REPORTER_ROLE)
        returns (uint256 reportId)
    {
        if (credits.length == 0) revert EmptyReport();
        reportId = nextReportId++;
        Report storage r = _reports[reportId];
        r.period = period;
        r.asOf = asOf;
        r.publishedAt = uint64(block.timestamp);
        r.publisher = msg.sender;
        r.status = Status.Draft;
        for (uint256 i = 0; i < credits.length; i++) {
            _credits[reportId].push(credits[i]);
        }
        _cash[reportId] = cash;
        if (reportOfPeriod[period] == 0) _periods.push(period);
        reportOfPeriod[period] = reportId;
        emit ReportPublished(reportId, period, asOf, msg.sender);
    }

    /// @notice 查核機構簽署定稿。簽過就不能再改。
    function attest(uint256 reportId, Status status, string calldata auditorName, string calldata note)
        external
        onlyRole(AUDITOR_ROLE)
    {
        Report storage r = _reports[reportId];
        if (r.publishedAt == 0) revert UnknownReport(reportId);
        if (r.status != Status.Draft) revert AlreadyAttested(reportId);
        r.status = status;
        r.auditor = msg.sender;
        r.auditorName = auditorName;
        r.note = note;
        r.attestedAt = uint64(block.timestamp);
        emit ReportAttested(reportId, msg.sender, status, note);
    }

    /// @notice 回寫報告全文 PDF 的 hash。定稿後仍可補件（文件本身不改變數字）。
    function setDocumentHash(uint256 reportId, bytes32 documentHash) external onlyRole(REPORTER_ROLE) {
        Report storage r = _reports[reportId];
        if (r.publishedAt == 0) revert UnknownReport(reportId);
        r.documentHash = documentHash;
        emit ReportDocument(reportId, documentHash);
    }

    // ───────────────────────── 查詢 ─────────────────────────

    function reportOf(uint256 reportId)
        external
        view
        returns (Report memory report, CreditReserve[] memory credits, CashReserve memory cash)
    {
        report = _reports[reportId];
        if (report.publishedAt == 0) revert UnknownReport(reportId);
        credits = _credits[reportId];
        cash = _cash[reportId];
    }

    function periods() external view returns (uint32[] memory) {
        return _periods;
    }

    function latestReportId() external view returns (uint256) {
        return nextReportId - 1;
    }
}
