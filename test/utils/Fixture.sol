// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {IKYCRegistry} from "../../src/interfaces/IKYCRegistry.sol";
import {KYCRegistry} from "../../src/identity/KYCRegistry.sol";
import {RetirementCertificate} from "../../src/registry/RetirementCertificate.sol";
import {CarbonCredit1155} from "../../src/registry/CarbonCredit1155.sol";
import {CarbonRegistry} from "../../src/registry/CarbonRegistry.sol";
import {Listing} from "../../src/market/Listing.sol";
import {CarbonCreditToken} from "../../src/market/CarbonCreditToken.sol";
import {CarbonPool} from "../../src/market/CarbonPool.sol";
import {CarbonKYCHook} from "../../src/v4/CarbonKYCHook.sol";
import {TrustedRouter} from "../../src/v4/TrustedRouter.sol";
import {MockTWD} from "../../src/mocks/MockTWD.sol";

/// @notice 共用測試環境：部署全套合約並建立幾個角色。
abstract contract Fixture is Test {
    // 治理角色
    address internal sovereign = makeAddr("sovereign"); // 國家單位（Phase 0 以 EOA 代替 Safe+Timelock）
    address internal operator = makeAddr("operator"); // CAFECA 代運營
    address internal treasury = makeAddr("treasury");

    // 簽章者
    uint256 internal identityVerifierPk = 0xA11CE;
    address internal identityVerifier = vm.addr(identityVerifierPk);
    uint256 internal carbonVerifierPk = 0xB0B;
    address internal carbonVerifier = vm.addr(carbonVerifierPk);

    // 市場參與者
    address internal companyA = makeAddr("companyA"); // 減量企業
    address internal companyB = makeAddr("companyB"); // 做市商 / 機構買方
    address internal alice = makeAddr("alice"); // 自然人
    address internal stranger = makeAddr("stranger"); // 未 KYC

    KYCRegistry internal kyc;
    RetirementCertificate internal cert;
    CarbonCredit1155 internal credit;
    CarbonRegistry internal registry;
    MockTWD internal twd;
    Listing internal listing;
    CarbonCreditToken internal cct;
    CarbonPool internal pool;
    PoolManager internal poolManager;
    CarbonKYCHook internal hook;
    TrustedRouter internal router;
    PoolKey internal poolKey;

    uint16 internal constant VINTAGE = 2025;
    uint64 internal constant MON_START = 1735689600; // 2025-01-01
    uint64 internal constant MON_END = 1767139200; // 2025-12-31

    function setUp() public virtual {
        vm.warp(1_800_000_000);

        // ── 身分層 ──
        KYCRegistry kycImpl = new KYCRegistry();
        kyc = KYCRegistry(
            address(
                new ERC1967Proxy(
                    address(kycImpl), abi.encodeCall(KYCRegistry.initialize, (sovereign, sovereign, operator))
                )
            )
        );
        bytes32 verifierRole = kyc.IDENTITY_VERIFIER_ROLE();
        vm.prank(sovereign);
        kyc.grantRole(verifierRole, identityVerifier);

        // ── 登錄層（不可升級）──
        cert = new RetirementCertificate(sovereign, operator);
        credit = new CarbonCredit1155(sovereign, sovereign, kyc, cert, "https://registry.example/credit/{id}");
        registry = new CarbonRegistry(sovereign, sovereign, kyc, credit);
        vm.startPrank(sovereign);
        credit.setRegistry(address(registry));
        cert.grantRole(cert.MINTER_ROLE(), address(credit));
        registry.approveVerifier(carbonVerifier);
        kyc.addRecoverableToken(address(credit));
        vm.stopPrank();

        // ── 市場層 ──
        twd = new MockTWD(operator);
        Listing listingImpl = new Listing();
        listing = Listing(
            address(
                new ERC1967Proxy(
                    address(listingImpl),
                    abi.encodeCall(Listing.initialize, (sovereign, operator, kyc, credit, twd, treasury, 100))
                )
            )
        );
        CarbonCreditToken cctImpl = new CarbonCreditToken();
        cct = CarbonCreditToken(
            address(
                new ERC1967Proxy(
                    address(cctImpl),
                    abi.encodeCall(
                        CarbonCreditToken.initialize, (sovereign, kyc, VINTAGE, "Carbon Credit Token 2025", "CCT25")
                    )
                )
            )
        );
        CarbonPool poolImpl = new CarbonPool();
        pool = CarbonPool(
            address(
                new ERC1967Proxy(
                    address(poolImpl),
                    abi.encodeCall(
                        CarbonPool.initialize, (sovereign, operator, kyc, credit, cct, VINTAGE, 500, treasury)
                    )
                )
            )
        );
        vm.startPrank(sovereign);
        cct.grantRole(cct.POOL_ROLE(), address(pool));
        kyc.addRecoverableToken(address(cct));
        kyc.setSystemContract(address(listing), true);
        kyc.setSystemContract(address(pool), true);
        vm.stopPrank();

        // ── Uniswap v4（非生產展示）──
        poolManager = new PoolManager(sovereign);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        address hookAddr = address(flags ^ (0x4444 << 144));
        deployCodeTo("CarbonKYCHook.sol:CarbonKYCHook", abi.encode(poolManager, kyc, sovereign, operator), hookAddr);
        hook = CarbonKYCHook(hookAddr);
        router = new TrustedRouter(poolManager);
        vm.startPrank(operator);
        hook.setTrustedRouter(address(router));
        hook.classifyToken(address(cct), true, false);
        hook.classifyToken(address(twd), false, true);
        vm.stopPrank();
        vm.startPrank(sovereign);
        kyc.setSystemContract(address(poolManager), true);
        vm.stopPrank();

        (Currency c0, Currency c1) = address(cct) < address(twd)
            ? (Currency.wrap(address(cct)), Currency.wrap(address(twd)))
            : (Currency.wrap(address(twd)), Currency.wrap(address(cct)));
        poolKey = PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: IHooks(hookAddr)});

        // ── 參與者 KYC ──
        _registerIdentity(companyA, IKYCRegistry.Tier.Corporate, keccak256("TW-12345678"));
        _registerIdentity(companyB, IKYCRegistry.Tier.Corporate, keccak256("TW-87654321"));
        _registerIdentity(alice, IKYCRegistry.Tier.Individual, keccak256("TW-A123456789"));

        vm.startPrank(operator);
        twd.mint(alice, 1_000_000e6);
        twd.mint(companyB, 100_000_000e6);
        vm.stopPrank();
    }

    // ───────────────────────── helpers ─────────────────────────

    function _attest(address account, IKYCRegistry.Tier tier, bytes32 identityHash, uint64 expiry)
        internal
        view
        returns (KYCRegistry.IdentityAttestation memory a, bytes memory sig)
    {
        a = KYCRegistry.IdentityAttestation({
            account: account,
            tier: tier,
            expiry: expiry,
            jurisdiction: bytes2("TW"),
            identityHash: identityHash,
            nonce: kyc.nonces(account),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(identityVerifierPk, kyc.hashAttestation(a));
        sig = abi.encodePacked(r, s, v);
    }

    function _registerIdentity(address account, IKYCRegistry.Tier tier, bytes32 identityHash) internal {
        (KYCRegistry.IdentityAttestation memory a, bytes memory sig) =
            _attest(account, tier, identityHash, uint64(block.timestamp + 365 days));
        kyc.register(a, sig);
    }

    function _retireReq(address holder, uint256 batchId, uint256 amountKg, address certificateTo)
        internal
        pure
        returns (CarbonCredit1155.RetireRequest memory)
    {
        return CarbonCredit1155.RetireRequest({
            holder: holder,
            batchId: batchId,
            amountKg: amountKg,
            certificateTo: certificateTo,
            beneficiaryHash: keccak256("beneficiary"),
            beneficiary: "Test Beneficiary Co.",
            purpose: RetirementCertificate.Purpose.CarbonFeeOffset,
            memo: "FY2025 carbon fee offset"
        });
    }

    function _registerProject(address owner) internal returns (uint256 projectId) {
        vm.prank(owner);
        projectId =
            registry.registerProject("Solar rooftop retrofit", "ISO 14064-2 / RE-01", "Taoyuan, TW", "ipfs://project");
    }

    function _issue(uint256 projectId, uint256 amountKg, bytes32 serial) internal returns (uint256 batchId) {
        (CarbonRegistry.IssuanceAttestation memory a, bytes memory sig) = _signIssue(projectId, amountKg, serial);
        batchId = registry.issue(a, sig);
    }

    function _signIssue(uint256 projectId, uint256 amountKg, bytes32 serial)
        internal
        view
        returns (CarbonRegistry.IssuanceAttestation memory a, bytes memory sig)
    {
        a = CarbonRegistry.IssuanceAttestation({
            projectId: projectId,
            monitoringStart: MON_START,
            monitoringEnd: MON_END,
            amountKg: amountKg,
            serialHash: serial,
            reportHash: keccak256(abi.encodePacked("report", serial)),
            attestationId: uint256(serial),
            deadline: block.timestamp + 1 days
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(carbonVerifierPk, registry.hashIssuance(a));
        sig = abi.encodePacked(r, s, v);
    }
}
