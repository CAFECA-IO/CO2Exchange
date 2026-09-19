// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {IKYCRegistry} from "../interfaces/IKYCRegistry.sol";

/// @title CarbonKYCHook
/// @notice Uniswap v4 hook：合規輔助防線（主防線在代幣層 _update）。
///
/// 為什麼 hook 不能是主防線：`sender` 是呼叫 PoolManager 的 Router，不是終端使用者；
/// 使用者只能透過 hookData 傳入，而 hookData 由呼叫方自填。因此本 hook：
///   1. 只接受 trustedRouter（由它把 msg.sender 編進 hookData）
///   2. beforeInitialize：只有 OPERATOR 可建池，且必須是「碳權代幣 × 結算代幣」
///   3. beforeSwap：使用者身分有效
///   4. afterSwap：以實際成交的碳權數量累計每日限額（用 delta，不用 amountSpecified，避免以另一邊計價繞過）
///   5. before{Add,Remove}Liquidity：只有法人（指定做市商）可提供流動性
///
/// 部署地址需符合 flag：0x2AC0（beforeInitialize | beforeAddLiquidity | beforeRemoveLiquidity | beforeSwap | afterSwap）
/// 注意：PoolManager.sol 為 BUSL-1.1，本 hook 僅供非生產展示；正式使用需 Uniswap Additional Use Grant。
contract CarbonKYCHook is IHooks, AccessControl {
    using PoolIdLibrary for PoolKey;

    bytes32 public constant SOVEREIGN_ROLE = keccak256("SOVEREIGN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    IPoolManager public immutable poolManager;
    IKYCRegistry public immutable kyc;
    address public trustedRouter;

    mapping(address => bool) public isCarbonToken;
    mapping(address => bool) public isSettlementToken;
    /// @notice 每日碳權成交上限（以碳權代幣最小單位計，1e18 = 1 噸）；0 = 不限
    mapping(IKYCRegistry.Tier => uint256) public dailyLimit;
    /// @notice user => day => 已成交碳權數量
    mapping(address => mapping(uint256 => uint256)) public dailyVolume;

    event TrustedRouterSet(address indexed router); // address(0) = 關閉所有 swap / 流動性操作
    event TokenClassified(address indexed token, bool carbon, bool settlement);
    event DailyLimitSet(IKYCRegistry.Tier tier, uint256 limit);
    event PoolAuthorized(PoolId indexed poolId, address carbonToken, address settlementToken);

    error NotPoolManager();
    error HookNotImplemented();
    error UntrustedRouter(address sender);
    error UnauthorizedPoolCreator(address sender);
    error InvalidPoolPair();
    error NotActiveAccount(address account);
    error NotCorporate(address account);
    error DailyLimitExceeded(address account, uint256 attempted, uint256 limit);

    constructor(IPoolManager poolManager_, IKYCRegistry kyc_, address admin, address sovereign, address operator) {
        poolManager = poolManager_;
        kyc = kyc_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SOVEREIGN_ROLE, sovereign);
        _grantRole(OPERATOR_ROLE, operator);
        _setRoleAdmin(OPERATOR_ROLE, SOVEREIGN_ROLE);
        Hooks.validateHookPermissions(this, getHookPermissions());
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ───────────────────────── 營運設定 ─────────────────────────

    function setTrustedRouter(address router) external onlyRole(OPERATOR_ROLE) {
        trustedRouter = router;
        emit TrustedRouterSet(router);
    }

    function classifyToken(address token, bool carbon, bool settlement) external onlyRole(OPERATOR_ROLE) {
        isCarbonToken[token] = carbon;
        isSettlementToken[token] = settlement;
        emit TokenClassified(token, carbon, settlement);
    }

    function setDailyLimit(IKYCRegistry.Tier tier, uint256 limit) external onlyRole(OPERATOR_ROLE) {
        dailyLimit[tier] = limit;
        emit DailyLimitSet(tier, limit);
    }

    // ───────────────────────── Hook callbacks ─────────────────────────

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        if (!hasRole(OPERATOR_ROLE, sender)) revert UnauthorizedPoolCreator(sender);
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        bool ok = (isCarbonToken[c0] && isSettlementToken[c1]) || (isCarbonToken[c1] && isSettlementToken[c0]);
        if (!ok) revert InvalidPoolPair();
        emit PoolAuthorized(key.toId(), isCarbonToken[c0] ? c0 : c1, isCarbonToken[c0] ? c1 : c0);
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(address sender, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata hookData)
        external
        view
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        address user = _user(sender, hookData);
        if (!kyc.isActive(user)) revert NotActiveAccount(user);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata,
        BalanceDelta delta,
        bytes calldata hookData
    ) external override onlyPoolManager returns (bytes4, int128) {
        address user = _user(sender, hookData);
        IKYCRegistry.Tier tier = kyc.tierOf(user);
        uint256 limit = dailyLimit[tier];
        if (limit > 0) {
            int128 carbonDelta = isCarbonToken[Currency.unwrap(key.currency0)] ? delta.amount0() : delta.amount1();
            uint256 traded = carbonDelta < 0 ? uint256(uint128(-carbonDelta)) : uint256(uint128(carbonDelta));
            uint256 day = block.timestamp / 1 days;
            uint256 used = dailyVolume[user][day] + traded;
            if (used > limit) revert DailyLimitExceeded(user, used, limit);
            dailyVolume[user][day] = used;
        }
        return (IHooks.afterSwap.selector, 0);
    }

    function beforeAddLiquidity(
        address sender,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata hookData
    ) external view override onlyPoolManager returns (bytes4) {
        _requireCorporate(_user(sender, hookData));
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeRemoveLiquidity(
        address sender,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata hookData
    ) external view override onlyPoolManager returns (bytes4) {
        _requireCorporate(_user(sender, hookData));
        return IHooks.beforeRemoveLiquidity.selector;
    }

    // 未啟用的 callbacks
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    // ───────────────────────── 內部 ─────────────────────────

    function _user(address sender, bytes calldata hookData) internal view returns (address user) {
        if (sender != trustedRouter) revert UntrustedRouter(sender);
        user = abi.decode(hookData, (address));
    }

    function _requireCorporate(address user) internal view {
        if (kyc.tierOf(user) != IKYCRegistry.Tier.Corporate || !kyc.isActive(user)) revert NotCorporate(user);
    }
}
