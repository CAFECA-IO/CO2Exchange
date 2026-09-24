// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IKYCRegistry} from "../interfaces/IKYCRegistry.sol";
import {IRecoverable} from "../interfaces/IRecoverable.sol";

/// @title KYCRegistry
/// @notice 身分層（UUPS 可升級）。
///
/// 身分根是政府憑證（工商憑證 / 自然人憑證 / TW FidO）。流程：
///   使用者以憑證對其鏈上地址簽章 → 身分驗證服務（IDENTITY_VERIFIER_ROLE）驗證憑證鏈與 OCSP
///   → 出具 EIP-712 attestation → 任何人可將 attestation 提交至 register()。
/// 鏈上只存 identityHash，不存個資。
///
/// 角色：
///   DEFAULT_ADMIN_ROLE     — 國家單位 Timelock；升級權、角色管理
///   SOVEREIGN_ROLE         — 國家單位：認可/撤銷身分驗證服務、凍結、登錄系統合約、政策開關
///   OPERATOR_ROLE          — CAFECA 代運營：執行 recover（需新 attestation 證明同一法律實體）
///   IDENTITY_VERIFIER_ROLE — 身分驗證服務的簽章金鑰
contract KYCRegistry is Initializable, UUPSUpgradeable, AccessControlUpgradeable, EIP712Upgradeable, IKYCRegistry {
    bytes32 public constant SOVEREIGN_ROLE = keccak256("SOVEREIGN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant IDENTITY_VERIFIER_ROLE = keccak256("IDENTITY_VERIFIER_ROLE");

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "IdentityAttestation(address account,uint8 tier,uint64 expiry,bytes2 jurisdiction,bytes32 identityHash,uint256 nonce,uint256 deadline)"
    );

    struct IdentityAttestation {
        address account;
        Tier tier;
        uint64 expiry;
        bytes2 jurisdiction;
        bytes32 identityHash;
        uint256 nonce;
        uint256 deadline;
    }

    mapping(address => Identity) private _identities;
    mapping(address => uint256) public nonces;
    /// @notice 由主權角色設定：是否允許自然人轉出額度（initialize 時設為 true）。
    ///         自然人在官方制度裡開不了額度帳戶，額度不可能登記在他名下，
    ///         所以他手上的本來就是「請求權」——請求權可以再轉給別人，沒有理由鎖住。
    bool public individualTransferEnabled;
    /// @notice 由主權角色設定：是否允許自然人註銷（預設 false）。
    ///         依交易拍賣及移轉管理辦法第 2 條第 1 款，「事業」限公司、行號、工廠、民間機構、
    ///         行政機關與各級政府，不含自然人；第 7 條開立額度帳戶須檢附設立登記證明。
    ///         自然人既無額度帳戶，就無從受領官方移轉、也無從在官方登錄簿註銷。
    ///         鏈上若讓他註銷，會產生一張官方端對不到任何紀錄的憑證——那比擋下來更糟。
    ///         將來主管機關若開放自然人帳戶，主權角色打開這個開關即可。
    bool public individualRetireEnabled;
    /// @notice 復原時要搬移餘額的代幣合約清單
    address[] public recoverableTokens;

    event IdentityRegistered(
        address indexed account, Tier tier, uint64 expiry, bytes2 jurisdiction, bytes32 identityHash, address verifier
    );
    event SystemContractSet(address indexed account, bool enabled);
    event FrozenSet(address indexed account, bool frozen);
    event Recovered(address indexed oldAccount, address indexed newAccount, bytes32 identityHash);
    event IndividualTransferPolicy(bool enabled);
    event IndividualRetirePolicy(bool enabled);
    event RecoverableTokenAdded(address indexed token);

    error InvalidAttestation();
    error AttestationExpired();
    error InvalidTier();
    error IdentityMismatch();
    error ZeroAddress();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address sovereign, address operator) external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __EIP712_init("CO2Exchange KYCRegistry", "1");
        // 自然人可以轉售（他持有的本來就是請求權），但不能註銷（官方端沒有他的額度帳戶）。
        individualTransferEnabled = true;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SOVEREIGN_ROLE, sovereign);
        _grantRole(OPERATOR_ROLE, operator);
        // 角色階層：主權（Safe，即時）可撤換營運與身分驗證服務；主權本身只能由 DEFAULT_ADMIN（Timelock，延遲）變更
        _setRoleAdmin(OPERATOR_ROLE, SOVEREIGN_ROLE);
        _setRoleAdmin(IDENTITY_VERIFIER_ROLE, SOVEREIGN_ROLE);
    }

    // ───────────────────────── 註冊 ─────────────────────────

    /// @notice 提交身分驗證服務簽發的 attestation。
    function register(IdentityAttestation calldata a, bytes calldata signature) external {
        if (a.tier != Tier.Individual && a.tier != Tier.Corporate) revert InvalidTier();
        if (block.timestamp > a.deadline) revert AttestationExpired();
        if (a.nonce != nonces[a.account]) revert InvalidAttestation();

        address signer = ECDSA.recover(_hashAttestation(a), signature);
        if (!hasRole(IDENTITY_VERIFIER_ROLE, signer)) revert InvalidAttestation();

        if (_identities[a.account].tier == Tier.SystemContract) revert InvalidTier();
        nonces[a.account]++;
        Identity storage id = _identities[a.account];
        // 凍結狀態不因重新驗證而解除
        id.tier = a.tier;
        id.expiry = a.expiry;
        id.jurisdiction = a.jurisdiction;
        id.identityHash = a.identityHash;
        emit IdentityRegistered(a.account, a.tier, a.expiry, a.jurisdiction, a.identityHash, signer);
    }

    /// @notice 登錄平台合約（Listing、CarbonPool、PoolManager、TrustedRouter…）。
    function setSystemContract(address account, bool enabled) external onlyRole(SOVEREIGN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        Identity storage id = _identities[account];
        if (enabled) {
            id.tier = Tier.SystemContract;
            id.expiry = 0;
        } else {
            delete _identities[account];
        }
        emit SystemContractSet(account, enabled);
    }

    function setFrozen(address account, bool frozen) external onlyRole(SOVEREIGN_ROLE) {
        _identities[account].frozen = frozen;
        emit FrozenSet(account, frozen);
    }

    function setIndividualTransferEnabled(bool enabled) external onlyRole(SOVEREIGN_ROLE) {
        individualTransferEnabled = enabled;
        emit IndividualTransferPolicy(enabled);
    }

    function setIndividualRetireEnabled(bool enabled) external onlyRole(SOVEREIGN_ROLE) {
        individualRetireEnabled = enabled;
        emit IndividualRetirePolicy(enabled);
    }

    function addRecoverableToken(address token) external onlyRole(SOVEREIGN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        recoverableTokens.push(token);
        emit RecoverableTokenAdded(token);
    }

    // ───────────────────────── 復原 ─────────────────────────

    /// @notice 帳戶復原。新地址需持有由身分驗證服務簽發、identityHash 與舊地址相同的 attestation，
    ///         證明是同一法律實體以憑證重新簽章。舊地址凍結並清除 tier，餘額搬到新地址。
    function recover(address oldAccount, IdentityAttestation calldata a, bytes calldata signature)
        external
        onlyRole(OPERATOR_ROLE)
    {
        Identity memory old = _identities[oldAccount];
        if (old.tier == Tier.None || old.tier == Tier.SystemContract) revert InvalidTier();
        if (a.identityHash != old.identityHash || a.tier != old.tier) revert IdentityMismatch();
        if (block.timestamp > a.deadline) revert AttestationExpired();
        if (a.nonce != nonces[a.account]) revert InvalidAttestation();
        address signer = ECDSA.recover(_hashAttestation(a), signature);
        if (!hasRole(IDENTITY_VERIFIER_ROLE, signer)) revert InvalidAttestation();

        nonces[a.account]++;
        _identities[a.account] = Identity({
            tier: a.tier, expiry: a.expiry, frozen: false, jurisdiction: a.jurisdiction, identityHash: a.identityHash
        });
        // 舊地址：保留 identityHash 作稽核，凍結且降為 None
        _identities[oldAccount].tier = Tier.None;
        _identities[oldAccount].frozen = true;

        for (uint256 i = 0; i < recoverableTokens.length; i++) {
            IRecoverable(recoverableTokens[i]).recoverBalances(oldAccount, a.account);
        }
        emit Recovered(oldAccount, a.account, a.identityHash);
    }

    // ───────────────────────── 查詢 ─────────────────────────

    function identityOf(address account) external view returns (Identity memory) {
        return _identities[account];
    }

    function tierOf(address account) public view returns (Tier) {
        return _identities[account].tier;
    }

    function isSystemContract(address account) public view returns (bool) {
        return _identities[account].tier == Tier.SystemContract;
    }

    function isActive(address account) public view returns (bool) {
        Identity memory id = _identities[account];
        if (id.tier == Tier.None || id.frozen) return false;
        if (id.tier == Tier.SystemContract) return true;
        return id.expiry > block.timestamp;
    }

    /// @notice 轉移前的白名單檢查。
    ///
    /// @dev **身分到期擋交易，不鎖資產。** 這是政策層一開始就定下來的原則
    ///      （見架構決策紀錄），但原本的實作沒有完整實現它：到期之後連「從託管把
    ///      自己的東西拿回來」都會被擋下。
    ///
    ///      在資產放在自己錢包裡的模型下，這個落差看不出來——到期的人不能交易，
    ///      但東西本來就在他名下。換成交易所資產池（綜合帳戶託管）之後，
    ///      「拿回自己的東西」變成一次轉移，於是到期就等於鎖住資產。
    ///
    ///      這個落差在逃生模式下最致命：營運方消失之後沒有人會再簽發 attestation，
    ///      所有人的身分遲早到期——逃生門會在它唯一會被用到的那一天失效。
    ///
    ///      所以放行一種情況：**從系統合約轉回一個「有身分、未凍結、只是過期」的帳戶**。
    ///      這不是網開一面：
    ///        · 凍結仍然擋（凍結是主管機關的處分，和效期是兩回事）
    ///        · 從來沒有身分的地址仍然擋（tier == None）
    ///        · 過期的人**拿回來之後仍然不能交易**（他當 from 的時候照樣被擋）
    ///      改變的只有「能不能把已經屬於他的東西還給他」，而答案本來就該是能。
    function checkTransfer(address from, address to) external view {
        Identity memory f = _identities[from];
        Identity memory t = _identities[to];
        if (f.frozen) revert Frozen(from);
        if (t.frozen) revert Frozen(to);
        if (!_active(f)) revert NotActive(from);
        if (!_active(t)) {
            bool returningFromCustody = f.tier == Tier.SystemContract && t.tier != Tier.None
                && t.tier != Tier.SystemContract;
            if (!returningFromCustody) revert NotActive(to);
        }
        if (f.tier == Tier.Individual && !individualTransferEnabled) revert IndividualTransferDisabled(from);
    }

    function checkRetire(address account) external view {
        Identity memory id = _identities[account];
        if (id.frozen) revert Frozen(account);
        if (id.tier == Tier.None || id.tier == Tier.SystemContract) revert NotActive(account);
        // 自然人不能註銷：官方登錄簿沒有他的額度帳戶，鏈上註銷會生出一張官方端對不到的憑證。
        // 自然人要處分手上的額度，走轉售（checkTransfer 允許）。
        if (id.tier == Tier.Individual && !individualRetireEnabled) revert IndividualRetireDisabled(account);
        // 到期不擋：註銷對任何人無害，且憑證仍可對應到 identityHash
    }

    function hashAttestation(IdentityAttestation calldata a) external view returns (bytes32) {
        return _hashAttestation(a);
    }

    function _hashAttestation(IdentityAttestation calldata a) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    a.account,
                    uint8(a.tier),
                    a.expiry,
                    a.jurisdiction,
                    a.identityHash,
                    a.nonce,
                    a.deadline
                )
            )
        );
    }

    function _active(Identity memory id) internal view returns (bool) {
        if (id.tier == Tier.None || id.frozen) return false;
        if (id.tier == Tier.SystemContract) return true;
        return id.expiry > block.timestamp;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
