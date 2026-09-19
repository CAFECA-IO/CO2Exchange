// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {CarbonKYCHook} from "../../src/v4/CarbonKYCHook.sol";
import {TrustedRouter} from "../../src/v4/TrustedRouter.sol";
import {Fixture} from "./Fixture.sol";

/// @notice Fixture + Uniswap v4 展示模組。
///
/// 只有需要 v4 的測試才繼承這個。v4-core 使用 transient storage（EIP-1153），
/// 在 `evm_version = shanghai` 之下編不過，所以 shanghai profile 會把這個檔案
/// 連同 src/v4/** 與 test/V4.t.sol 一起 skip 掉 —— 核心測試不受影響。
abstract contract V4Fixture is Fixture {
    PoolManager internal poolManager;
    CarbonKYCHook internal hook;
    TrustedRouter internal router;
    PoolKey internal poolKey;

    function _setUpV4() internal override {
        poolManager = new PoolManager(sovereign);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        address hookAddr = address(flags ^ (0x4444 << 144));
        deployCodeTo(
            "CarbonKYCHook.sol:CarbonKYCHook", abi.encode(poolManager, kyc, sovereign, sovereign, operator), hookAddr
        );
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
    }
}
