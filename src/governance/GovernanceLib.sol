// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Safe} from "safe-smart-account/Safe.sol";
import {SafeProxyFactory} from "safe-smart-account/proxies/SafeProxyFactory.sol";
import {SafeProxy} from "safe-smart-account/proxies/SafeProxy.sol";
import {CompatibilityFallbackHandler} from "safe-smart-account/handler/CompatibilityFallbackHandler.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title GovernanceLib
/// @notice 部署治理基礎設施：Safe v1.4.1（singleton / factory / fallback handler）、Safe 多簽帳戶、OpenZeppelin TimelockController。
///         許可鏈上沒有現成的 Safe 部署，所以由本專案自行部署；正式環境可改填既有地址。
library GovernanceLib {
    struct SafeInfra {
        Safe singleton;
        SafeProxyFactory factory;
        CompatibilityFallbackHandler fallbackHandler;
    }

    function deploySafeInfra() internal returns (SafeInfra memory infra) {
        infra.singleton = new Safe();
        infra.factory = new SafeProxyFactory();
        infra.fallbackHandler = new CompatibilityFallbackHandler();
    }

    /// @notice 建立一個 Safe 多簽（owners 任意順序、threshold-of-n）
    function createSafe(SafeInfra memory infra, address[] memory owners, uint256 threshold, uint256 saltNonce)
        internal
        returns (Safe safe)
    {
        bytes memory initializer = abi.encodeCall(
            Safe.setup,
            (owners, threshold, address(0), "", address(infra.fallbackHandler), address(0), 0, payable(address(0)))
        );
        SafeProxy proxy = infra.factory.createProxyWithNonce(address(infra.singleton), initializer, saltNonce);
        safe = Safe(payable(address(proxy)));
    }

    /// @notice 國家單位的 Timelock：只有國家 Safe 能提案與執行；取消權也在國家 Safe；Timelock 自己是 admin（沒有外部超級管理員）。
    function deployTimelock(uint256 minDelay, address nationalSafe) internal returns (TimelockController tl) {
        address[] memory proposers = new address[](1);
        proposers[0] = nationalSafe;
        address[] memory executors = new address[](1);
        executors[0] = nationalSafe;
        tl = new TimelockController(minDelay, proposers, executors, address(0));
    }
}
