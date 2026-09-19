// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {KYCRegistry} from "../src/identity/KYCRegistry.sol";
import {IKYCRegistry} from "../src/interfaces/IKYCRegistry.sol";
import {Listing} from "../src/market/Listing.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @dev 模擬「政策升級」：加一個 version()，儲存布局不變。
contract KYCRegistryV2 is KYCRegistry {
    function version() external pure returns (string memory) {
        return "2";
    }
}

/// @notice 治理與移轉：主權角色由 CAFECA 交給國家單位只是換地址；營運角色可被單方面撤銷；
///         登錄簿不可升級、身分/市場層可升級且只有 DEFAULT_ADMIN 能升級。
contract GovernanceTest is Fixture {
    address internal nationalAgency = makeAddr("nationalAgency");

    function test_handover_sovereignRoleToNationalAgency() public {
        bytes32 admin = kyc.DEFAULT_ADMIN_ROLE();
        bytes32 sov = kyc.SOVEREIGN_ROLE();

        // 移轉當天：授予國家單位，CAFECA/建置方 renounce
        vm.startPrank(sovereign);
        kyc.grantRole(admin, nationalAgency);
        kyc.grantRole(sov, nationalAgency);
        kyc.renounceRole(admin, sovereign);
        kyc.renounceRole(sov, sovereign);
        vm.stopPrank();

        assertTrue(kyc.hasRole(sov, nationalAgency));
        assertFalse(kyc.hasRole(sov, sovereign));

        // 舊主權地址不能再凍結
        vm.prank(sovereign);
        vm.expectRevert();
        kyc.setFrozen(alice, true);

        // 國家單位可以
        vm.prank(nationalAgency);
        kyc.setFrozen(alice, true);
        assertTrue(kyc.identityOf(alice).frozen);
    }

    function test_sovereignCanRevokeOperatorUnilaterally() public {
        bytes32 op = listing.OPERATOR_ROLE();
        vm.prank(sovereign);
        listing.revokeRole(op, operator);
        vm.prank(operator);
        vm.expectRevert();
        listing.pause();
    }

    function test_upgrade_onlyAdmin() public {
        KYCRegistryV2 v2 = new KYCRegistryV2();
        vm.prank(operator);
        vm.expectRevert();
        UUPSUpgradeable(address(kyc)).upgradeToAndCall(address(v2), "");

        vm.prank(sovereign);
        UUPSUpgradeable(address(kyc)).upgradeToAndCall(address(v2), "");
        assertEq(KYCRegistryV2(address(kyc)).version(), "2");
        // 狀態保留
        assertTrue(kyc.isActive(companyA));
        assertEq(uint8(kyc.tierOf(alice)), uint8(IKYCRegistry.Tier.Individual));
    }

    function test_registryLayerHasNoUpgradePath() public {
        // 不可升級合約沒有 upgradeToAndCall；用低階 call 確認會失敗
        (bool ok,) = address(credit).call(abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(0), ""));
        assertFalse(ok);
        (ok,) = address(registry).call(abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(0), ""));
        assertFalse(ok);
        (ok,) = address(cert).call(abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(0), ""));
        assertFalse(ok);
    }

    function test_credit_registryCanOnlyBeSetOnce() public {
        vm.prank(sovereign);
        vm.expectRevert();
        credit.setRegistry(address(0xBEEF));
    }
}
