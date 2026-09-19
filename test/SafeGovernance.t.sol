// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {SafeHelper} from "./utils/SafeHelper.sol";
import {Safe} from "safe-smart-account/Safe.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {GovernanceLib} from "../src/governance/GovernanceLib.sol";
import {KYCRegistry} from "../src/identity/KYCRegistry.sol";
import {IKYCRegistry} from "../src/interfaces/IKYCRegistry.sol";

contract KYCRegistryV2 is KYCRegistry {
    function version() external pure returns (string memory) {
        return "2";
    }
}

/// @notice 用真實 Safe v1.4.1 多簽與 OpenZeppelin Timelock 走完移轉後的治理流程。
///   國家 Safe 2-of-3：緊急權（凍結、暫停、撤換營運）即時；結構權（升級、角色結構）經 Timelock 48h。
///   營運 Safe 1-of-2：暫停 / 恢復、手續費、recover。
contract SafeGovernanceTest is Fixture {
    using SafeHelper for Safe;

    uint256[3] internal natPk = [uint256(0xA1), 0xA2, 0xA3];
    uint256[2] internal opPk = [uint256(0xB1), 0xB2];
    Safe internal nationalSafe;
    Safe internal operatorSafe;
    TimelockController internal timelock;
    bytes32 internal constant ADMIN = 0x00;
    bytes32 internal SOV = keccak256("SOVEREIGN_ROLE");
    bytes32 internal OP = keccak256("OPERATOR_ROLE");

    function setUp() public override {
        super.setUp();
        GovernanceLib.SafeInfra memory infra = GovernanceLib.deploySafeInfra();
        address[] memory nat = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            nat[i] = vm.addr(natPk[i]);
        }
        address[] memory op = new address[](2);
        for (uint256 i = 0; i < 2; i++) {
            op[i] = vm.addr(opPk[i]);
        }
        nationalSafe = GovernanceLib.createSafe(infra, nat, 2, 1);
        operatorSafe = GovernanceLib.createSafe(infra, op, 1, 2);
        timelock = GovernanceLib.deployTimelock(48 hours, address(nationalSafe));

        // 移轉（與 Deploy.s.sol 的 _handover 相同）
        address[4] memory withOp = [address(kyc), address(cert), address(listing), address(pool)];
        address[2] memory sovOnly = [address(credit), address(registry)];
        vm.startPrank(sovereign);
        for (uint256 i = 0; i < withOp.length; i++) {
            IAccessControl c = IAccessControl(withOp[i]);
            c.grantRole(SOV, address(nationalSafe));
            c.grantRole(ADMIN, address(timelock));
            c.renounceRole(SOV, sovereign);
            c.renounceRole(ADMIN, sovereign);
        }
        for (uint256 i = 0; i < sovOnly.length; i++) {
            IAccessControl c = IAccessControl(sovOnly[i]);
            c.grantRole(SOV, address(nationalSafe));
            c.grantRole(ADMIN, address(timelock));
            c.renounceRole(SOV, sovereign);
            c.renounceRole(ADMIN, sovereign);
        }
        cct.grantRole(ADMIN, address(timelock));
        cct.renounceRole(ADMIN, sovereign);
        vm.stopPrank();
        // 營運：原 operator EOA → 營運 Safe（由國家 Safe 執行，SOVEREIGN 是 OPERATOR 的 admin）
        for (uint256 i = 0; i < withOp.length; i++) {
            nationalSafe.exec(_nat2(), withOp[i], abi.encodeCall(IAccessControl.grantRole, (OP, address(operatorSafe))));
            nationalSafe.exec(_nat2(), withOp[i], abi.encodeCall(IAccessControl.revokeRole, (OP, operator)));
        }
    }

    // ── 移轉結果 ──

    function test_handover_noEoaHoldsGovernance() public view {
        assertFalse(kyc.hasRole(ADMIN, sovereign));
        assertFalse(kyc.hasRole(SOV, sovereign));
        assertFalse(kyc.hasRole(OP, operator));
        assertTrue(kyc.hasRole(ADMIN, address(timelock)));
        assertTrue(kyc.hasRole(SOV, address(nationalSafe)));
        assertTrue(kyc.hasRole(OP, address(operatorSafe)));
        assertEq(nationalSafe.getThreshold(), 2);
    }

    // ── 緊急權：國家 Safe 2-of-3 即時 ──

    function test_nationalSafe_freezeImmediately() public {
        nationalSafe.exec(_nat2(), address(kyc), abi.encodeCall(KYCRegistry.setFrozen, (alice, true)));
        assertTrue(kyc.identityOf(alice).frozen);
    }

    function test_nationalSafe_singleSignerRejected() public {
        uint256[] memory one = new uint256[](1);
        one[0] = natPk[0];
        nationalSafe.execExpectRevert(one, address(kyc), abi.encodeCall(KYCRegistry.setFrozen, (alice, true))); // GS020
        assertFalse(kyc.identityOf(alice).frozen);
    }

    function test_nationalSafe_revokesOperatorWithoutDelay() public {
        nationalSafe.exec(
            _nat2(), address(listing), abi.encodeCall(IAccessControl.revokeRole, (OP, address(operatorSafe)))
        );
        assertFalse(listing.hasRole(OP, address(operatorSafe)));
        // 營運 Safe 再也不能暫停
        operatorSafe.execExpectRevert(_op1(), address(listing), abi.encodeCall(listing.pause, ())); // GS013
    }

    function test_nationalSafe_canPauseAsEmergency() public {
        nationalSafe.exec(_nat2(), address(listing), abi.encodeCall(listing.pause, ()));
        assertTrue(listing.paused());
    }

    // ── 營運權：營運 Safe ──

    function test_operatorSafe_pauseAndUnpause() public {
        operatorSafe.exec(_op1(), address(listing), abi.encodeCall(listing.pause, ()));
        assertTrue(listing.paused());
        operatorSafe.exec(_op1(), address(listing), abi.encodeCall(listing.unpause, ()));
        assertFalse(listing.paused());
    }

    function test_operatorSafe_cannotFreezeOrGrantRoles() public {
        operatorSafe.execExpectRevert(_op1(), address(kyc), abi.encodeCall(KYCRegistry.setFrozen, (alice, true)));
        operatorSafe.execExpectRevert(
            _op1(), address(kyc), abi.encodeCall(IAccessControl.grantRole, (SOV, address(operatorSafe)))
        );
    }

    // ── 結構權：升級必須經 Timelock 48h ──

    function test_upgrade_throughTimelock() public {
        KYCRegistryV2 v2 = new KYCRegistryV2();
        bytes memory data = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (address(v2), ""));
        bytes32 salt = keccak256("upgrade-kyc-v2");

        // 國家 Safe 不能直接升級（DEFAULT_ADMIN 在 Timelock）
        nationalSafe.execExpectRevert(_nat2(), address(kyc), data);

        nationalSafe.schedule(_nat2(), timelock, address(kyc), data, salt);

        // 未到期不能執行
        nationalSafe.executeExpectRevert(_nat2(), timelock, address(kyc), data, salt);

        vm.warp(vm.getBlockTimestamp() + 48 hours);
        nationalSafe.execute(_nat2(), timelock, address(kyc), data, salt);
        assertEq(KYCRegistryV2(address(kyc)).version(), "2");
        assertTrue(kyc.isActive(companyA)); // 狀態保留
    }

    function test_timelock_onlyNationalSafeCanPropose() public {
        bytes memory data = abi.encodeCall(IAccessControl.grantRole, (SOV, operator));
        vm.prank(operator);
        vm.expectRevert();
        timelock.schedule(address(kyc), 0, data, bytes32(0), keccak256("x"), 48 hours);
    }

    function test_sovereignRoleChange_requiresTimelock() public {
        // SOVEREIGN 的 admin 是 DEFAULT_ADMIN（Timelock）：國家 Safe 不能直接把主權給別人
        nationalSafe.execExpectRevert(_nat2(), address(kyc), abi.encodeCall(IAccessControl.grantRole, (SOV, operator)));

        bytes memory data = abi.encodeCall(IAccessControl.grantRole, (SOV, operator));
        bytes32 salt = keccak256("sov");
        nationalSafe.schedule(_nat2(), timelock, address(kyc), data, salt);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        nationalSafe.execute(_nat2(), timelock, address(kyc), data, salt);
        assertTrue(kyc.hasRole(SOV, operator));
    }

    function test_registryLayer_sovereignActionsWork() public {
        // 不可升級合約的主權操作：認可查驗機構、凍結批次
        address newVerifier = makeAddr("verifier2");
        nationalSafe.exec(_nat2(), address(registry), abi.encodeCall(registry.approveVerifier, (newVerifier)));
        assertTrue(registry.hasRole(registry.VERIFIER_ROLE(), newVerifier));
    }

    // ── helpers ──
    function _nat2() internal view returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = natPk[0];
        a[1] = natPk[2];
    }

    function _op1() internal view returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = opPk[1];
    }
}
