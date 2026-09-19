// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {KYCRegistry} from "../src/identity/KYCRegistry.sol";
import {RetirementCertificate} from "../src/registry/RetirementCertificate.sol";
import {CarbonCredit1155} from "../src/registry/CarbonCredit1155.sol";
import {CarbonRegistry} from "../src/registry/CarbonRegistry.sol";
import {Listing} from "../src/market/Listing.sol";
import {CarbonCreditToken} from "../src/market/CarbonCreditToken.sol";
import {CarbonPool} from "../src/market/CarbonPool.sol";
import {MockTWD} from "../src/mocks/MockTWD.sol";
import {PasskeyAccountFactory} from "../src/account/PasskeyAccountFactory.sol";
import {GovernanceLib} from "../src/governance/GovernanceLib.sol";
import {Safe} from "safe-smart-account/Safe.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Phase 0 一鍵部署（Anvil）。
///
/// 環境變數（皆有 Anvil 預設值）：
///   DEPLOYER_PK        部署者私鑰
///   SOVEREIGN          國家單位地址（Phase 0 用 EOA；正式為 Safe + Timelock）
///   OPERATOR           CAFECA 代運營地址
///   TREASURY           手續費收款
///   IDENTITY_VERIFIER  身分驗證服務簽章地址
///   CARBON_VERIFIER    查驗機構簽章地址
///   VINTAGE_YEAR       第一個池的年份（預設 2025）
///
/// 用法：
///   anvil &
///   forge script script/Deploy.s.sol --rpc-url anvil --broadcast
contract Deploy is Script {
    struct Config {
        uint256 pk;
        address deployer;
        address sovereign;
        address operator;
        address treasury;
        address identityVerifier;
        address carbonVerifier;
        address documentSigner; // 憑證 PDF hash 回寫服務
        uint16 vintage;
        // 治理
        address nationalSafe; // 既有 Safe 地址；為 0 則以 nationalOwners/threshold 建立
        address operatorSafe;
        address[] nationalOwners;
        uint256 nationalThreshold;
        address[] operatorOwners;
        uint256 operatorThreshold;
        uint256 timelockDelay;
    }

    Config internal cfg;

    // 部署結果放在 storage，避免 stack too deep
    KYCRegistry public kyc;
    RetirementCertificate public cert;
    CarbonCredit1155 public credit;
    CarbonRegistry public registry;
    MockTWD public twd;
    Listing public listing;
    CarbonCreditToken public cct;
    CarbonPool public pool;
    // v4 模組的三個地址。核心部署不含 v4，維持 address(0)；
    // DeployV4 會填進來。用 address 而不是具體型別，核心編譯單元才不必 import v4。
    address public poolManager;
    address public hook;
    address public router;
    PasskeyAccountFactory public accountFactory;
    Safe public nationalSafe;
    Safe public operatorSafe;
    TimelockController public timelock;
    GovernanceLib.SafeInfra internal safeInfra;

    function run() external {
        deployAll();
    }

    /// @dev 完整部署 + 佈線 + 移轉。DemoFlow 也走這條路。
    function deployAll() internal {
        _loadConfig();
        _deployGovernance();
        _deployCore();
        _deployAccountFactory();
        _deployV4();
        _wireAsSovereign();
        _wireAsOperator();
        _initPool();
        _handover();
        _print();
        _writeDeployment();
    }

    function _loadConfig() internal {
        cfg.pk = vm.envOr("DEPLOYER_PK", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        cfg.deployer = vm.addr(cfg.pk);
        cfg.sovereign = vm.envOr("SOVEREIGN", cfg.deployer);
        cfg.operator = vm.envOr("OPERATOR", cfg.deployer);
        cfg.treasury = vm.envOr("TREASURY", cfg.deployer);
        cfg.identityVerifier = vm.envOr("IDENTITY_VERIFIER", cfg.deployer);
        cfg.carbonVerifier = vm.envOr("CARBON_VERIFIER", cfg.deployer);
        cfg.documentSigner = vm.envOr("DOCUMENT_SIGNER", cfg.deployer);
        cfg.vintage = uint16(vm.envOr("VINTAGE_YEAR", uint256(2025)));

        // Phase 0 預設：國家 Safe = Anvil 帳戶 5,6,7（2-of-3）；營運 Safe = 帳戶 8,9（1-of-2）；Timelock 48h
        address[] memory nat = new address[](3);
        nat[0] = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc;
        nat[1] = 0x976EA74026E726554dB657fA54763abd0C3a0aa9;
        nat[2] = 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955;
        address[] memory op = new address[](2);
        op[0] = 0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f;
        op[1] = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;
        cfg.nationalSafe = vm.envOr("NATIONAL_SAFE", address(0));
        cfg.operatorSafe = vm.envOr("OPERATOR_SAFE", address(0));
        cfg.nationalOwners = vm.envOr("NATIONAL_OWNERS", ",", nat);
        cfg.nationalThreshold = vm.envOr("NATIONAL_THRESHOLD", uint256(2));
        cfg.operatorOwners = vm.envOr("OPERATOR_OWNERS", ",", op);
        cfg.operatorThreshold = vm.envOr("OPERATOR_THRESHOLD", uint256(1));
        cfg.timelockDelay = vm.envOr("TIMELOCK_DELAY", uint256(48 hours));
    }

    /// @dev 治理基礎設施：Safe v1.4.1 + 兩個多簽 + 國家單位 Timelock。
    function _deployGovernance() internal {
        vm.startBroadcast(cfg.pk);
        if (cfg.nationalSafe == address(0) || cfg.operatorSafe == address(0)) {
            safeInfra = GovernanceLib.deploySafeInfra();
        }
        nationalSafe = cfg.nationalSafe != address(0)
            ? Safe(payable(cfg.nationalSafe))
            : GovernanceLib.createSafe(safeInfra, cfg.nationalOwners, cfg.nationalThreshold, 1);
        operatorSafe = cfg.operatorSafe != address(0)
            ? Safe(payable(cfg.operatorSafe))
            : GovernanceLib.createSafe(safeInfra, cfg.operatorOwners, cfg.operatorThreshold, 2);
        timelock = GovernanceLib.deployTimelock(cfg.timelockDelay, address(nationalSafe));
        vm.stopBroadcast();
    }

    function _deployCore() internal {
        vm.startBroadcast(cfg.pk);

        // ── 身分層 ──
        kyc = KYCRegistry(
            address(
                new ERC1967Proxy(
                    address(new KYCRegistry()),
                    abi.encodeCall(KYCRegistry.initialize, (cfg.sovereign, cfg.sovereign, cfg.operator))
                )
            )
        );

        // ── 登錄層（不可升級）──
        cert = new RetirementCertificate(cfg.sovereign, cfg.sovereign, cfg.operator);
        credit =
            new CarbonCredit1155(cfg.sovereign, cfg.sovereign, kyc, cert, "https://co2exchange.example/credit/{id}");
        registry = new CarbonRegistry(cfg.sovereign, cfg.sovereign, kyc, credit);

        // ── 市場層（UUPS）──
        twd = new MockTWD(cfg.operator);
        listing = Listing(
            address(
                new ERC1967Proxy(
                    address(new Listing()),
                    abi.encodeCall(
                        Listing.initialize,
                        (cfg.sovereign, cfg.sovereign, cfg.operator, kyc, credit, twd, cfg.treasury, 100)
                    )
                )
            )
        );
        cct = CarbonCreditToken(
            address(
                new ERC1967Proxy(
                    address(new CarbonCreditToken()),
                    abi.encodeCall(
                        CarbonCreditToken.initialize,
                        (
                            cfg.sovereign,
                            kyc,
                            cfg.vintage,
                            string.concat("Carbon Credit Token ", vm.toString(uint256(cfg.vintage))),
                            "CCT"
                        )
                    )
                )
            )
        );
        pool = CarbonPool(
            address(
                new ERC1967Proxy(
                    address(new CarbonPool()),
                    abi.encodeCall(
                        CarbonPool.initialize,
                        (cfg.sovereign, cfg.sovereign, cfg.operator, kyc, credit, cct, cfg.vintage, 500, cfg.treasury)
                    )
                )
            )
        );
        vm.stopBroadcast();
    }

    /// @dev 帳戶層，與 v4 無關 —— 不含 v4 的核心部署一樣要有。
    function _deployAccountFactory() internal {
        vm.startBroadcast(cfg.pk);
        accountFactory = new PasskeyAccountFactory();
        vm.stopBroadcast();
    }

    /// @dev v4 展示模組的掛載點。核心部署不含 v4（這樣才能在沒有 EIP-1153 的鏈上編譯與執行）；
    ///      DeployV4 會覆寫這個函式。見 script/DeployV4.s.sol。
    function _deployV4() internal virtual {}

    /// @dev Phase 0 預設 deployer == sovereign == operator。正式環境這些由 Safe 交易執行。
    function _wireAsSovereign() internal {
        require(cfg.deployer == cfg.sovereign, "Phase 0 script expects deployer == sovereign");
        vm.startBroadcast(cfg.pk);
        credit.setRegistry(address(registry));
        cert.grantRole(cert.MINTER_ROLE(), address(credit));
        cert.grantRole(cert.DOCUMENT_ROLE(), cfg.documentSigner);
        cct.grantRole(cct.POOL_ROLE(), address(pool));
        kyc.grantRole(kyc.IDENTITY_VERIFIER_ROLE(), cfg.identityVerifier);
        registry.approveVerifier(cfg.carbonVerifier);
        kyc.addRecoverableToken(address(credit));
        kyc.addRecoverableToken(address(cct));
        kyc.setSystemContract(address(listing), true);
        kyc.setSystemContract(address(pool), true);
        if (poolManager != address(0)) kyc.setSystemContract(poolManager, true);
        vm.stopBroadcast();
    }

    /// @dev 目前 OPERATOR 的佈線只有 v4 hook，核心部署沒有東西要做。
    function _wireAsOperator() internal virtual {}

    /// @dev 建池由 DeployV4 覆寫（需要 v4 型別）。
    function _initPool() internal virtual {}

    /// @dev 移轉：DEFAULT_ADMIN（升級、角色結構）→ Timelock；SOVEREIGN（緊急權）→ 國家 Safe；OPERATOR → 營運 Safe；
    ///      部署者 renounce 全部治理角色。保留的服務角色：身分驗證服務簽章、查驗機構簽章、MockTWD 鑄幣（demo faucet）。
    function _handover() internal {
        bytes32 ADMIN = 0x00;
        bytes32 SOV = keccak256("SOVEREIGN_ROLE");
        bytes32 OP = keccak256("OPERATOR_ROLE");
        address[7] memory withOperator =
            [address(kyc), address(cert), address(listing), address(pool), hook, address(0), address(0)];
        address[2] memory sovereignOnly = [address(credit), address(registry)];

        vm.startBroadcast(cfg.pk);
        for (uint256 i = 0; i < withOperator.length; i++) {
            address c = withOperator[i];
            if (c == address(0)) continue;
            IAccessControl(c).grantRole(SOV, address(nationalSafe));
            IAccessControl(c).grantRole(OP, address(operatorSafe));
            IAccessControl(c).grantRole(ADMIN, address(timelock));
            IAccessControl(c).renounceRole(OP, cfg.deployer);
            IAccessControl(c).renounceRole(SOV, cfg.deployer);
            IAccessControl(c).renounceRole(ADMIN, cfg.deployer);
        }
        for (uint256 i = 0; i < sovereignOnly.length; i++) {
            address c = sovereignOnly[i];
            IAccessControl(c).grantRole(SOV, address(nationalSafe));
            IAccessControl(c).grantRole(ADMIN, address(timelock));
            IAccessControl(c).renounceRole(SOV, cfg.deployer);
            IAccessControl(c).renounceRole(ADMIN, cfg.deployer);
        }
        // CCT：只有 DEFAULT_ADMIN（升級）
        cct.grantRole(ADMIN, address(timelock));
        cct.renounceRole(ADMIN, cfg.deployer);
        // MockTWD：管理權給營運 Safe，鑄幣權保留給 deployer 供 demo faucet
        twd.grantRole(ADMIN, address(operatorSafe));
        twd.renounceRole(ADMIN, cfg.deployer);
        vm.stopBroadcast();
    }

    function _print() internal view {
        console2.log("KYCRegistry          ", address(kyc));
        console2.log("RetirementCertificate", address(cert));
        console2.log("CarbonCredit1155     ", address(credit));
        console2.log("CarbonRegistry       ", address(registry));
        console2.log("MockTWD              ", address(twd));
        console2.log("Listing              ", address(listing));
        console2.log("CarbonCreditToken    ", address(cct));
        console2.log("CarbonPool           ", address(pool));
        console2.log("PoolManager          ", poolManager);
        console2.log("CarbonKYCHook        ", hook);
        console2.log("TrustedRouter        ", router);
        console2.log("PasskeyAccountFactory", address(accountFactory));
        console2.log("NationalSafe         ", address(nationalSafe));
        console2.log("OperatorSafe         ", address(operatorSafe));
        console2.log("Timelock             ", address(timelock));
    }

    /// @dev 前端讀 deployments/<chainId>.json
    function _writeDeployment() internal {
        string memory j = "d";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeAddress(j, "kycRegistry", address(kyc));
        vm.serializeAddress(j, "retirementCertificate", address(cert));
        vm.serializeAddress(j, "carbonCredit1155", address(credit));
        vm.serializeAddress(j, "carbonRegistry", address(registry));
        vm.serializeAddress(j, "settlementToken", address(twd));
        vm.serializeAddress(j, "listing", address(listing));
        vm.serializeAddress(j, "cct", address(cct));
        vm.serializeAddress(j, "carbonPool", address(pool));
        vm.serializeAddress(j, "poolManager", poolManager);
        vm.serializeAddress(j, "hook", hook);
        vm.serializeAddress(j, "router", router);
        vm.serializeUint(j, "poolFee", 3000);
        vm.serializeUint(j, "tickSpacing", 60);
        vm.serializeAddress(j, "accountFactory", address(accountFactory));
        vm.serializeAddress(j, "nationalSafe", address(nationalSafe));
        vm.serializeAddress(j, "operatorSafe", address(operatorSafe));
        vm.serializeUint(j, "timelockDelay", cfg.timelockDelay);
        string memory out = vm.serializeAddress(j, "timelock", address(timelock));
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
