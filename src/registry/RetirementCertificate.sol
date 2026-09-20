// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @title RetirementCertificate
/// @notice 註銷憑證（ERC-721，不可轉讓、不可升級）。
///         每次註銷產生一張憑證，對應到特定額度批次與序號段，供碳費扣抵或其他申報附件使用。
///         正式 PDF 由營運方離線產生，其 hash 由 OPERATOR 寫回鏈上。
contract RetirementCertificate is ERC721, AccessControl {
    bytes32 public constant SOVEREIGN_ROLE = keccak256("SOVEREIGN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE"); // CarbonCredit1155
    /// @dev 憑證文件服務的金鑰：只能回寫 PDF hash。由 OPERATOR（營運 Safe）授予 / 撤銷。
    bytes32 public constant DOCUMENT_ROLE = keccak256("DOCUMENT_ROLE");

    /// @notice 註銷用途。對齊環境部「溫室氣體減量額度管理系統」（TCER Registry）四種註銷申請書的分類。
    ///         不自行發明類別：申請書分幾類，鏈上就是幾類，回填官方註銷編號時才對得起來。
    enum Purpose {
        CarbonFee, // 扣除碳費排放量
        VoluntaryNeutrality, // 自願性碳中和或碳抵換
        IncrementOffset, // 溫室氣體增量抵換
        EiaCommitment // 環評承諾事項
    }

    struct Certificate {
        uint256 batchId; // CarbonCredit1155 tokenId
        uint256 amountKg; // 註銷噸數（kgCO2e）
        bytes32 beneficiaryHash; // hash(受益人統編/身分證 + salt)
        string beneficiary; // 受益人顯示名稱（可空）
        Purpose purpose;
        string memo;
        address retiredBy;
        uint64 retiredAt;
        bytes32 documentHash; // 正式憑證 PDF hash，由 OPERATOR 事後寫入
        /// @dev 官方註銷回填。本站額度由代辦方（CAFECA）持有於環境部額度帳戶，
        ///      鏈上註銷先行完成、官方註銷隨後辦理，完成後把編號與公開日寫回來。
        ///      兩者都空 = 尚未完成官方程序，憑證上必須照實標示。
        string officialNo; // 環境部註銷編號
        uint64 officialAnnouncedAt; // 主管機關公開日（unix 秒）
        /// @dev 額度的核發國／轄區（ISO 3166-1 alpha-2）與機制名稱。
        ///      一張沒寫明「哪一國核發」的憑證，拿去申報時沒有人能判斷它合不合用。
        bytes2 country;
        string scheme;
    }

    uint256 public nextId = 1;
    mapping(uint256 => Certificate) private _certs;

    event Retired(
        uint256 indexed certId,
        uint256 indexed batchId,
        address indexed retiredBy,
        address owner,
        uint256 amountKg,
        bytes32 beneficiaryHash,
        Purpose purpose,
        bytes2 country
    );
    event DocumentHashSet(uint256 indexed certId, bytes32 documentHash);
    event OfficialRetirementSet(uint256 indexed certId, string officialNo, uint64 announcedAt);

    error Soulbound();

    constructor(address admin, address sovereign, address operator)
        ERC721("CO2Exchange Retirement Certificate", "CO2-RET")
    {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SOVEREIGN_ROLE, sovereign);
        _grantRole(OPERATOR_ROLE, operator);
        _setRoleAdmin(OPERATOR_ROLE, SOVEREIGN_ROLE);
        _setRoleAdmin(DOCUMENT_ROLE, OPERATOR_ROLE);
    }

    function mint(address to, Certificate memory c) external onlyRole(MINTER_ROLE) returns (uint256 certId) {
        certId = nextId++;
        _certs[certId] = c;
        _safeMint(to, certId);
        emit Retired(certId, c.batchId, c.retiredBy, to, c.amountKg, c.beneficiaryHash, c.purpose, c.country);
    }

    function setDocumentHash(uint256 certId, bytes32 documentHash) external onlyRole(DOCUMENT_ROLE) {
        _requireOwned(certId);
        _certs[certId].documentHash = documentHash;
        emit DocumentHashSet(certId, documentHash);
    }

    /// @notice 回填官方註銷結果。
    /// @dev 依交易拍賣及移轉管理辦法第 27 條，主管機關於註銷次日起五個工作日內公開；
    ///      公開之後事業才可以對外做環境聲明。前端據 announcedAt 算出可宣告日。
    function setOfficialRetirement(uint256 certId, string calldata officialNo, uint64 announcedAt)
        external
        onlyRole(DOCUMENT_ROLE)
    {
        _requireOwned(certId);
        _certs[certId].officialNo = officialNo;
        _certs[certId].officialAnnouncedAt = announcedAt;
        emit OfficialRetirementSet(certId, officialNo, announcedAt);
    }

    function certificateOf(uint256 certId) external view returns (Certificate memory) {
        _requireOwned(certId);
        return _certs[certId];
    }

    /// @dev 不可轉讓：只允許 mint。
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function tokenURI(uint256 certId) public view override returns (string memory) {
        _requireOwned(certId);
        Certificate memory c = _certs[certId];
        // 分兩段組字串：一次 encodePacked 太多參數會 stack too deep。
        bytes memory head = abi.encodePacked(
            '{"name":"Retirement Certificate #',
            Strings.toString(certId),
            '","description":"CO2Exchange carbon credit retirement certificate","attributes":[',
            '{"trait_type":"batchId","value":"',
            Strings.toString(c.batchId),
            '"},{"trait_type":"amountKg","value":"',
            Strings.toString(c.amountKg),
            '"},{"trait_type":"purpose","value":"',
            Strings.toString(uint256(c.purpose))
        );
        bytes memory tail = abi.encodePacked(
            '"},{"trait_type":"country","value":"',
            string(abi.encodePacked(c.country)),
            '"},{"trait_type":"scheme","value":"',
            c.scheme,
            '"},{"trait_type":"retiredAt","value":"',
            Strings.toString(c.retiredAt),
            '"},{"trait_type":"beneficiaryHash","value":"',
            Strings.toHexString(uint256(c.beneficiaryHash), 32),
            '"}]}'
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(abi.encodePacked(head, tail))));
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
