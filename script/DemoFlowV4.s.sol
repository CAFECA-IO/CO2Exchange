// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {DemoFlow} from "./DemoFlow.s.sol";
import {Deploy} from "./Deploy.s.sol";
import {DeployV4} from "./DeployV4.s.sol";
import {TrustedRouter} from "../src/v4/TrustedRouter.sol";

/// @notice 完整展示：核心 + v4 池 + 做市商流動性 + v4 買入。
///         需要支援 EIP-1153 的鏈；鏈比 Cancun 舊時改用 script/DemoFlow.s.sol。
///
/// 用法：forge script script/DemoFlowV4.s.sol --rpc-url anvil --broadcast --sig "demo()"
contract DemoFlowV4 is DemoFlow, DeployV4 {
    // DemoFlow 與 DeployV4 都繼承自 Deploy，菱形繼承必須明示要用哪一支實作。
    /// @dev DemoFlow 與 DeployV4 都繼承自 Deploy，多重繼承要明寫用哪一個。國外額度的種子在 DemoFlow。
    function _seedImportedProjects() internal override(Deploy, DemoFlow) {
        DemoFlow._seedImportedProjects();
    }

    function _deployV4() internal override(Deploy, DeployV4) {
        DeployV4._deployV4();
    }

    function _wireAsOperator() internal override(Deploy, DeployV4) {
        DeployV4._wireAsOperator();
    }

    function _initPool() internal override(Deploy, DeployV4) {
        DeployV4._initPool();
    }

    /// @dev 在 DemoFlow 已開好的 PK_B broadcast 之內執行，所以這裡不能再 startBroadcast。
    function _demoProvideLiquidity() internal override returns (bool) {
        cct.approve(router, type(uint256).max);
        twd.approve(router, type(uint256).max);
        TrustedRouter(router).modifyLiquidity(
            poolKey(),
            IPoolManager.ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: 1e15,
                salt: 0
            }),
            block.timestamp + 300
        );
        return true;
    }

    /// @dev 同樣在 PK_ALICE 的 broadcast 之內。
    function _demoSwap() internal override {
        twd.approve(router, type(uint256).max);
        bool zeroForOne = Currency.unwrap(poolKey().currency0) == address(twd);
        TrustedRouter(router).swap(
            poolKey(),
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(4_000e6),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            0,
            block.timestamp + 300
        );
    }
}
