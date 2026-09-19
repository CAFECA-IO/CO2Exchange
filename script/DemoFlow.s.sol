// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Deploy} from "./Deploy.s.sol";
import {KYCRegistry} from "../src/identity/KYCRegistry.sol";
import {IKYCRegistry} from "../src/interfaces/IKYCRegistry.sol";
import {CarbonRegistry} from "../src/registry/CarbonRegistry.sol";
import {CarbonCredit1155} from "../src/registry/CarbonCredit1155.sol";
import {RetirementCertificate} from "../src/registry/RetirementCertificate.sol";

/// @notice 提案展示：部署後跑完整流程（Anvil 預設帳戶）。
///   account0 = 部署者 / 國家單位 / 營運 / 身分驗證服務 / 查驗機構（Phase 0 合一）
///   account1 = 減量企業 companyA
///   account2 = 做市商 companyB
///   account3 = 自然人 alice
///
/// 用法：anvil & ; forge script script/DemoFlow.s.sol --rpc-url anvil --broadcast
contract DemoFlow is Deploy {
    uint256 constant PK_A = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant PK_B = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant PK_ALICE = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    function demo() external {
        _loadConfig();
        _deployCore();
        _deployV4();
        _wireAsSovereign();
        _wireAsOperator();
        _initPool();
        _print();
        _writeDeployment();
        address companyA = vm.addr(PK_A);
        address companyB = vm.addr(PK_B);
        address alice = vm.addr(PK_ALICE);

        // 1. 身分：憑證驗證服務簽發 attestation（Phase 0 由 account0 模擬）
        _register(companyA, IKYCRegistry.Tier.Corporate, keccak256("TW-UBN-12345678"));
        _register(companyB, IKYCRegistry.Tier.Corporate, keccak256("TW-UBN-87654321"));
        _register(alice, IKYCRegistry.Tier.Individual, keccak256("TW-ID-A123456789"));

        // 2. 專案登錄 + 查驗機構簽章核發 100 噸
        vm.startBroadcast(PK_A);
        uint256 pid = registry.registerProject(
            unicode"屋頂太陽能替代柴油發電", "ISO 14064-2 / RE-01", "Taoyuan, TW", "ipfs://demo"
        );
        vm.stopBroadcast();
        uint256 batch = _issue(pid, 100_000, keccak256("TW-2025-RE01-000001-100000"));

        // 3. 結算幣
        vm.startBroadcast(cfg.pk);
        twd.mint(alice, 100_000e6);
        twd.mint(companyB, 10_000_000e6);
        vm.stopBroadcast();

        // 4. companyA：30 噸掛單（800/噸），60 噸入池，40 CCT 給做市商
        vm.startBroadcast(PK_A);
        credit.setApprovalForAll(address(listing), true);
        credit.setApprovalForAll(address(pool), true);
        listing.list(batch, 30_000, 800e6, 100);
        pool.deposit(batch, 60_000);
        cct.transfer(companyB, 40e18);
        vm.stopBroadcast();

        // 5. companyB 提供 v4 流動性
        vm.startBroadcast(PK_B);
        cct.approve(address(router), type(uint256).max);
        twd.approve(address(router), type(uint256).max);
        router.modifyLiquidity(
            poolKey(),
            IPoolManager.ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: 1e15,
                salt: 0
            }),
            block.timestamp + 300
        );
        vm.stopBroadcast();

        // 6. alice：掛單買 2 噸；v4 買 4000 元；兩邊都註銷
        vm.startBroadcast(PK_ALICE);
        twd.approve(address(listing), type(uint256).max);
        twd.approve(address(router), type(uint256).max);
        listing.buy(1, 2_000);
        bool zeroForOne = Currency.unwrap(poolKey().currency0) == address(twd);
        router.swap(
            poolKey(),
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(4_000e6),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            0,
            block.timestamp + 300
        );
        uint256 kg = cct.balanceOf(alice) / 1e15;
        pool.redeemAndRetire(
            kg,
            keccak256("TW-ID-A123456789"),
            "Alice Chen",
            RetirementCertificate.Purpose.Voluntary,
            unicode"2026 差旅"
        );
        credit.retire(
            CarbonCredit1155.RetireRequest({
                holder: alice,
                batchId: batch,
                amountKg: 2_000,
                certificateTo: alice,
                beneficiaryHash: keccak256("TW-ID-A123456789"),
                beneficiary: "Alice Chen",
                purpose: RetirementCertificate.Purpose.CarbonFeeOffset,
                memo: "FY2025"
            })
        );
        vm.stopBroadcast();

        console2.log("--- demo state ---");
        console2.log("batch retiredKg      ", credit.batchOf(batch).retiredKg);
        console2.log("alice certificates   ", cert.balanceOf(alice));
        console2.log("alice CCT            ", cct.balanceOf(alice));
        console2.log("companyA mTWD        ", twd.balanceOf(companyA));
        console2.log("listing remainingKg  ", listing.orderOf(1).remainingKg);
        console2.log("pool pooledKg        ", pool.pooledKg(batch));
    }

    function _register(address account, IKYCRegistry.Tier tier, bytes32 identityHash) internal {
        KYCRegistry.IdentityAttestation memory a = KYCRegistry.IdentityAttestation({
            account: account,
            tier: tier,
            expiry: uint64(block.timestamp + 365 days),
            jurisdiction: bytes2("TW"),
            identityHash: identityHash,
            nonce: kyc.nonces(account),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(cfg.pk, kyc.hashAttestation(a));
        vm.startBroadcast(cfg.pk);
        kyc.register(a, abi.encodePacked(r, s, v));
        vm.stopBroadcast();
    }

    function _issue(uint256 projectId, uint256 amountKg, bytes32 serial) internal returns (uint256 batchId) {
        CarbonRegistry.IssuanceAttestation memory a = CarbonRegistry.IssuanceAttestation({
            projectId: projectId,
            monitoringStart: 1735689600,
            monitoringEnd: 1767139200,
            amountKg: amountKg,
            serialHash: serial,
            reportHash: keccak256("ISO14064-3 verification report"),
            attestationId: 1,
            deadline: block.timestamp + 1 days
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(cfg.pk, registry.hashIssuance(a));
        vm.startBroadcast(cfg.pk);
        batchId = registry.issue(a, abi.encodePacked(r, s, v));
        vm.stopBroadcast();
    }
}
