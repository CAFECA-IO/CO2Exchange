// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {V4Fixture} from "./utils/V4Fixture.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CarbonKYCHook} from "../src/v4/CarbonKYCHook.sol";
import {IKYCRegistry} from "../src/interfaces/IKYCRegistry.sol";
import {RetirementCertificate} from "../src/registry/RetirementCertificate.sol";

contract V4Test is V4Fixture {
    uint256 internal batch;
    bool internal twdIsCurrency0;

    function setUp() public override {
        super.setUp();
        twdIsCurrency0 = Currency.unwrap(poolKey.currency0) == address(twd);

        // 100 噸額度 → 池化 → 一半給做市商 companyB
        uint256 pid = _registerProject(companyA);
        batch = _issue(pid, 100_000, keccak256("V4"));
        vm.startPrank(companyA);
        credit.setApprovalForAll(address(pool), true);
        pool.deposit(batch, 100_000);
        cct.transfer(companyB, 50e18);
        vm.stopPrank();

        // 建池：800 mTWD / 噸
        vm.prank(operator);
        poolManager.initialize(poolKey, _sqrtPrice800());

        // companyB 提供全範圍流動性
        vm.startPrank(companyB);
        cct.approve(address(router), type(uint256).max);
        twd.approve(address(router), type(uint256).max);
        router.modifyLiquidity(
            poolKey,
            IPoolManager.ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: 1e15,
                salt: 0
            }),
            block.timestamp + 1
        );
        vm.stopPrank();

        vm.startPrank(alice);
        twd.approve(address(router), type(uint256).max);
        cct.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    // ── 建池控制 ──

    function test_initialize_onlyOperator() public {
        PoolKey memory k = poolKey;
        k.fee = 500; // 另一個池
        vm.prank(alice);
        vm.expectRevert();
        poolManager.initialize(k, _sqrtPrice800());
        vm.prank(operator);
        poolManager.initialize(k, _sqrtPrice800());
    }

    function test_initialize_rejectsNonCarbonPair() public {
        PoolKey memory k = poolKey;
        // 用 credit 合約地址假裝另一個代幣（未分類）
        (Currency a, Currency b) = address(credit) < address(twd)
            ? (Currency.wrap(address(credit)), Currency.wrap(address(twd)))
            : (Currency.wrap(address(twd)), Currency.wrap(address(credit)));
        k.currency0 = a;
        k.currency1 = b;
        vm.prank(operator);
        vm.expectRevert();
        poolManager.initialize(k, _sqrtPrice800());
    }

    // ── 流動性 ──

    function test_addLiquidity_individualRejected() public {
        vm.prank(alice);
        vm.expectRevert();
        router.modifyLiquidity(
            poolKey,
            IPoolManager.ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: 1e12, salt: 0}),
            block.timestamp + 1
        );
    }

    function test_removeLiquidity_corporateOk() public {
        vm.prank(companyB);
        router.modifyLiquidity(
            poolKey,
            IPoolManager.ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: -5e14,
                salt: 0
            }),
            block.timestamp + 1
        );
    }

    // ── Swap ──

    function test_swap_individualBuysCct() public {
        uint256 before = cct.balanceOf(alice);
        vm.prank(alice);
        router.swap(poolKey, _buyCct(4_000e6), 4e18, block.timestamp + 1); // 4000 TWD，至少 4 噸
        assertGt(cct.balanceOf(alice) - before, 4e18);
        assertLt(cct.balanceOf(alice) - before, 5.1e18);
    }

    function test_swap_unverifiedRejected() public {
        vm.prank(operator);
        twd.mint(stranger, 10_000e6);
        vm.startPrank(stranger);
        twd.approve(address(router), type(uint256).max);
        vm.expectRevert();
        router.swap(poolKey, _buyCct(1_000e6), 0, block.timestamp + 1);
        vm.stopPrank();
    }

    function test_swap_untrustedRouterRejected() public {
        PoolSwapTest other = new PoolSwapTest(poolManager);
        vm.startPrank(alice);
        twd.approve(address(other), type(uint256).max);
        vm.expectRevert();
        other.swap(poolKey, _buyCct(1_000e6), PoolSwapTest.TestSettings(false, false), abi.encode(alice));
        vm.stopPrank();
    }

    function test_swap_individualCannotSell() public {
        vm.prank(alice);
        router.swap(poolKey, _buyCct(4_000e6), 0, block.timestamp + 1);
        // 賣回：CCT 從自然人轉出 → 代幣層擋下（主防線）
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.IndividualTransferDisabled.selector, alice));
        router.swap(poolKey, _sellCct(1e18), 0, block.timestamp + 1);
    }

    function test_swap_dailyLimitEnforcedByActualDelta() public {
        vm.prank(operator);
        hook.setDailyLimit(IKYCRegistry.Tier.Individual, 5e18); // 每日 5 噸

        vm.prank(alice);
        router.swap(poolKey, _buyCct(3_000e6), 0, block.timestamp + 1); // ≈3.7 噸

        vm.prank(alice);
        vm.expectRevert();
        router.swap(poolKey, _buyCct(3_000e6), 0, block.timestamp + 1); // 累計超過 5 噸

        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        router.swap(poolKey, _buyCct(3_000e6), 0, block.timestamp + 1); // 新的一天
    }

    function test_endToEnd_buyThenRetire() public {
        vm.prank(alice);
        router.swap(poolKey, _buyCct(2_000e6), 0, block.timestamp + 1);
        uint256 kg = cct.balanceOf(alice) / 1e15;
        vm.prank(alice);
        uint256[] memory certs = pool.redeemAndRetire(
            kg, keccak256("A123456789"), "Alice Chen", RetirementCertificate.Purpose.Voluntary, "2026 flights"
        );
        assertEq(cert.ownerOf(certs[0]), alice);
        assertEq(cert.certificateOf(certs[0]).amountKg, kg);
        assertEq(credit.batchOf(batch).retiredKg, kg);
    }

    // ── helpers ──

    function _buyCct(uint256 twdIn) internal view returns (IPoolManager.SwapParams memory) {
        bool zeroForOne = twdIsCurrency0;
        return IPoolManager.SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(twdIn),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
    }

    function _sellCct(uint256 cctIn) internal view returns (IPoolManager.SwapParams memory) {
        bool zeroForOne = !twdIsCurrency0;
        return IPoolManager.SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(cctIn),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
    }

    /// @dev 800 mTWD(6 dec) / 1 CCT(18 dec)。sqrtPriceX96 = sqrt(amount1/amount0) * 2^96
    function _sqrtPrice800() internal view returns (uint160) {
        uint256 num;
        uint256 den;
        if (twdIsCurrency0) {
            num = 1e18;
            den = 800e6;
        } else {
            num = 800e6;
            den = 1e18;
        }
        return uint160(Math.sqrt(Math.mulDiv(num, 1 << 192, den)));
    }
}
