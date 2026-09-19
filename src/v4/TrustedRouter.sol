// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TrustedRouter
/// @notice 平台自有 Router。把 msg.sender 編進 hookData 交給 CarbonKYCHook，
///         並直接在使用者與 PoolManager 之間結算（Router 本身不持有代幣）。
///         不支援原生幣（許可鏈上結算幣為 ERC-20）。
contract TrustedRouter is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;

    enum Action {
        Swap,
        ModifyLiquidity
    }

    struct CallbackData {
        Action action;
        address user;
        PoolKey key;
        IPoolManager.SwapParams swapParams;
        IPoolManager.ModifyLiquidityParams liquidityParams;
    }

    error NotPoolManager();
    error Expired();
    error TooLittleReceived(uint256 received, uint256 minimum);

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    /// @param minAmountOut exactIn 時的最小輸出；exactOut 時忽略（以 sqrtPriceLimitX96 控制）
    function swap(PoolKey calldata key, IPoolManager.SwapParams calldata params, uint256 minAmountOut, uint256 deadline)
        external
        returns (BalanceDelta delta)
    {
        if (block.timestamp > deadline) revert Expired();
        IPoolManager.ModifyLiquidityParams memory empty;
        delta = abi.decode(
            poolManager.unlock(abi.encode(CallbackData(Action.Swap, msg.sender, key, params, empty))), (BalanceDelta)
        );
        if (params.amountSpecified < 0) {
            int128 out = params.zeroForOne ? delta.amount1() : delta.amount0();
            uint256 received = out > 0 ? uint256(uint128(out)) : 0;
            if (received < minAmountOut) revert TooLittleReceived(received, minAmountOut);
        }
    }

    function modifyLiquidity(PoolKey calldata key, IPoolManager.ModifyLiquidityParams calldata params, uint256 deadline)
        external
        returns (BalanceDelta delta)
    {
        if (block.timestamp > deadline) revert Expired();
        IPoolManager.SwapParams memory empty;
        delta = abi.decode(
            poolManager.unlock(abi.encode(CallbackData(Action.ModifyLiquidity, msg.sender, key, empty, params))),
            (BalanceDelta)
        );
    }

    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        CallbackData memory d = abi.decode(rawData, (CallbackData));
        bytes memory hookData = abi.encode(d.user);

        BalanceDelta delta;
        if (d.action == Action.Swap) {
            delta = poolManager.swap(d.key, d.swapParams, hookData);
        } else {
            (delta,) = poolManager.modifyLiquidity(d.key, d.liquidityParams, hookData);
        }

        _settle(d.key.currency0, d.user);
        _settle(d.key.currency1, d.user);
        return abi.encode(delta);
    }

    function _settle(Currency currency, address user) internal {
        int256 delta = poolManager.currencyDelta(address(this), currency);
        if (delta < 0) {
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransferFrom(user, address(poolManager), uint256(-delta));
            poolManager.settle();
        } else if (delta > 0) {
            poolManager.take(currency, user, uint256(delta));
        }
    }
}
