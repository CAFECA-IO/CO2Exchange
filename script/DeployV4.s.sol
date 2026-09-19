// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {CarbonKYCHook} from "../src/v4/CarbonKYCHook.sol";
import {TrustedRouter} from "../src/v4/TrustedRouter.sol";
import {HookMiner} from "./utils/HookMiner.sol";
import {Deploy} from "./Deploy.s.sol";

/// @notice 核心部署 + Uniswap v4 展示模組。
///
/// **這個檔案是整個專案唯一對 v4-core 有編譯期相依的部署腳本。**
/// v4-core 的 PoolManager 使用 transient storage（EIP-1153），因此：
///   - 目標鏈必須支援 Cancun（EIP-1153 + EIP-5656），否則部署會失敗
///   - `evm_version = shanghai` 之下這個檔案根本編不過，要用 shanghai profile 把它 skip 掉
///
/// 鏈比 Cancun 舊時改用 `script/Deploy.s.sol`（核心部署，不含 v4）——
/// 登錄層、身分層、Listing 主市場、池化、註銷憑證、Safe + Timelock 治理、passkey 帳戶工廠
/// 全部照常，只少掉 v4 這塊展示。主市場本來就是 Listing。
///
/// 用法：
///   ./script/preflight.sh <rpc>   # 先確認鏈支援 EIP-1153
///   forge script script/DeployV4.s.sol --rpc-url chain --broadcast
contract DeployV4 is Deploy {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev 部署 PoolManager、挖出符合權限旗標的 hook 地址、部署 TrustedRouter。
    function _deployV4() internal virtual override {
        vm.startBroadcast(cfg.pk);
        // 非生產展示：PoolManager.sol 為 BUSL-1.1
        PoolManager pm = new PoolManager(address(timelock)); // 協議費控制權在國家單位 Timelock
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        bytes memory hookArgs = abi.encode(pm, kyc, cfg.sovereign, cfg.sovereign, cfg.operator);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(CarbonKYCHook).creationCode, hookArgs);
        CarbonKYCHook h = new CarbonKYCHook{salt: salt}(pm, kyc, cfg.sovereign, cfg.sovereign, cfg.operator);
        require(address(h) == hookAddr, "hook address mismatch");
        TrustedRouter r = new TrustedRouter(pm);
        vm.stopBroadcast();

        poolManager = address(pm);
        hook = address(h);
        router = address(r);
    }

    function _wireAsOperator() internal virtual override {
        require(cfg.deployer == cfg.operator, "Phase 0 script expects deployer == operator");
        vm.startBroadcast(cfg.pk);
        CarbonKYCHook(hook).setTrustedRouter(router);
        CarbonKYCHook(hook).classifyToken(address(cct), true, false);
        CarbonKYCHook(hook).classifyToken(address(twd), false, true);
        vm.stopBroadcast();
    }

    /// @dev 建池：800 mTWD / 噸
    function _initPool() internal virtual override {
        vm.startBroadcast(cfg.pk);
        PoolManager(poolManager).initialize(poolKey(), sqrtPrice(800e6));
        vm.stopBroadcast();
    }

    function poolKey() public view returns (PoolKey memory) {
        address c = address(cct);
        address t = address(twd);
        (Currency c0, Currency c1) = c < t ? (Currency.wrap(c), Currency.wrap(t)) : (Currency.wrap(t), Currency.wrap(c));
        return PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: IHooks(hook)});
    }

    /// @dev pricePerTonne 以結算幣最小單位計（6 decimals）；CCT 18 decimals。sqrtPriceX96 = sqrt(amount1/amount0)·2^96
    function sqrtPrice(uint256 pricePerTonne) public view returns (uint160) {
        bool twdIs0 = address(twd) < address(cct);
        (uint256 num, uint256 den) = twdIs0 ? (uint256(1e18), pricePerTonne) : (pricePerTonne, uint256(1e18));
        return uint160(Math.sqrt(Math.mulDiv(num, 1 << 192, den)));
    }
}
