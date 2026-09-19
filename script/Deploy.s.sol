// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {KYCRegistry} from "../src/identity/KYCRegistry.sol";
import {RetirementCertificate} from "../src/registry/RetirementCertificate.sol";
import {CarbonCredit1155} from "../src/registry/CarbonCredit1155.sol";
import {CarbonRegistry} from "../src/registry/CarbonRegistry.sol";
import {Listing} from "../src/market/Listing.sol";
import {CarbonCreditToken} from "../src/market/CarbonCreditToken.sol";
import {CarbonPool} from "../src/market/CarbonPool.sol";
import {CarbonKYCHook} from "../src/v4/CarbonKYCHook.sol";
import {TrustedRouter} from "../src/v4/TrustedRouter.sol";
import {MockTWD} from "../src/mocks/MockTWD.sol";
import {PasskeyAccountFactory} from "../src/account/PasskeyAccountFactory.sol";
import {HookMiner} from "./utils/HookMiner.sol";

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
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    struct Config {
        uint256 pk;
        address deployer;
        address sovereign;
        address operator;
        address treasury;
        address identityVerifier;
        address carbonVerifier;
        uint16 vintage;
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
    PoolManager public poolManager;
    CarbonKYCHook public hook;
    TrustedRouter public router;
    PasskeyAccountFactory public accountFactory;

    function run() external {
        _loadConfig();
        _deployCore();
        _deployV4();
        _wireAsSovereign();
        _wireAsOperator();
        _initPool();
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
        cfg.vintage = uint16(vm.envOr("VINTAGE_YEAR", uint256(2025)));
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
        cert = new RetirementCertificate(cfg.sovereign, cfg.operator);
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
                        Listing.initialize, (cfg.sovereign, cfg.operator, kyc, credit, twd, cfg.treasury, 100)
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
                        (cfg.sovereign, cfg.operator, kyc, credit, cct, cfg.vintage, 500, cfg.treasury)
                    )
                )
            )
        );
        vm.stopBroadcast();
    }

    function _deployV4() internal {
        vm.startBroadcast(cfg.pk);
        // 非生產展示：PoolManager.sol 為 BUSL-1.1
        poolManager = new PoolManager(cfg.sovereign);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        bytes memory hookArgs = abi.encode(poolManager, kyc, cfg.sovereign, cfg.operator);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(CarbonKYCHook).creationCode, hookArgs);
        hook = new CarbonKYCHook{salt: salt}(poolManager, kyc, cfg.sovereign, cfg.operator);
        require(address(hook) == hookAddr, "hook address mismatch");
        router = new TrustedRouter(poolManager);
        accountFactory = new PasskeyAccountFactory();
        vm.stopBroadcast();
    }

    /// @dev Phase 0 預設 deployer == sovereign == operator。正式環境這些由 Safe 交易執行。
    function _wireAsSovereign() internal {
        require(cfg.deployer == cfg.sovereign, "Phase 0 script expects deployer == sovereign");
        vm.startBroadcast(cfg.pk);
        credit.setRegistry(address(registry));
        cert.grantRole(cert.MINTER_ROLE(), address(credit));
        cct.grantRole(cct.POOL_ROLE(), address(pool));
        kyc.grantRole(kyc.IDENTITY_VERIFIER_ROLE(), cfg.identityVerifier);
        registry.approveVerifier(cfg.carbonVerifier);
        kyc.addRecoverableToken(address(credit));
        kyc.addRecoverableToken(address(cct));
        kyc.setSystemContract(address(listing), true);
        kyc.setSystemContract(address(pool), true);
        kyc.setSystemContract(address(poolManager), true);
        vm.stopBroadcast();
    }

    function _wireAsOperator() internal {
        require(cfg.deployer == cfg.operator, "Phase 0 script expects deployer == operator");
        vm.startBroadcast(cfg.pk);
        hook.setTrustedRouter(address(router));
        hook.classifyToken(address(cct), true, false);
        hook.classifyToken(address(twd), false, true);
        vm.stopBroadcast();
    }

    /// @dev 建池：800 mTWD / 噸
    function _initPool() internal {
        vm.startBroadcast(cfg.pk);
        poolManager.initialize(poolKey(), sqrtPrice(800e6));
        vm.stopBroadcast();
    }

    function poolKey() public view returns (PoolKey memory) {
        address c = address(cct);
        address t = address(twd);
        (Currency c0, Currency c1) = c < t ? (Currency.wrap(c), Currency.wrap(t)) : (Currency.wrap(t), Currency.wrap(c));
        return PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(hook))});
    }

    /// @dev pricePerTonne 以結算幣最小單位計（6 decimals）；CCT 18 decimals。sqrtPriceX96 = sqrt(amount1/amount0)·2^96
    function sqrtPrice(uint256 pricePerTonne) public view returns (uint160) {
        bool twdIs0 = address(twd) < address(cct);
        (uint256 num, uint256 den) = twdIs0 ? (uint256(1e18), pricePerTonne) : (pricePerTonne, uint256(1e18));
        return uint160(Math.sqrt(Math.mulDiv(num, 1 << 192, den)));
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
        console2.log("PoolManager          ", address(poolManager));
        console2.log("CarbonKYCHook        ", address(hook));
        console2.log("TrustedRouter        ", address(router));
        console2.log("PasskeyAccountFactory", address(accountFactory));
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
        vm.serializeAddress(j, "poolManager", address(poolManager));
        vm.serializeAddress(j, "hook", address(hook));
        vm.serializeAddress(j, "router", address(router));
        vm.serializeUint(j, "poolFee", 3000);
        vm.serializeUint(j, "tickSpacing", 60);
        string memory out = vm.serializeAddress(j, "accountFactory", address(accountFactory));
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
