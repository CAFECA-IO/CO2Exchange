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
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE"); // CarbonCredit1155

    enum Purpose {
        Voluntary, // 自願抵銷
        CarbonFeeOffset, // 碳費扣抵
        CBAM, // CBAM 申報（目前僅記錄用途，效力視法規）
        Other
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
        Purpose purpose
    );
    event DocumentHashSet(uint256 indexed certId, bytes32 documentHash);

    error Soulbound();

    constructor(address admin, address operator) ERC721("CO2Exchange Retirement Certificate", "CO2-RET") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, operator);
    }

    function mint(address to, Certificate memory c) external onlyRole(MINTER_ROLE) returns (uint256 certId) {
        certId = nextId++;
        _certs[certId] = c;
        _safeMint(to, certId);
        emit Retired(certId, c.batchId, c.retiredBy, to, c.amountKg, c.beneficiaryHash, c.purpose);
    }

    function setDocumentHash(uint256 certId, bytes32 documentHash) external onlyRole(OPERATOR_ROLE) {
        _requireOwned(certId);
        _certs[certId].documentHash = documentHash;
        emit DocumentHashSet(certId, documentHash);
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
        bytes memory json = abi.encodePacked(
            '{"name":"Retirement Certificate #',
            Strings.toString(certId),
            '","description":"CO2Exchange carbon credit retirement certificate","attributes":[',
            '{"trait_type":"batchId","value":"',
            Strings.toString(c.batchId),
            '"},{"trait_type":"amountKg","value":"',
            Strings.toString(c.amountKg),
            '"},{"trait_type":"purpose","value":"',
            Strings.toString(uint256(c.purpose)),
            '"},{"trait_type":"retiredAt","value":"',
            Strings.toString(c.retiredAt),
            '"},{"trait_type":"beneficiaryHash","value":"',
            Strings.toHexString(uint256(c.beneficiaryHash), 32),
            '"}]}'
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
