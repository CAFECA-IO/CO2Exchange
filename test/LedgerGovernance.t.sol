// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Safe} from "safe-smart-account/Safe.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {SafeHelper} from "./utils/SafeHelper.sol";
import {GovernanceLib} from "../src/governance/GovernanceLib.sol";
import {Ledger} from "../src/ledger/Ledger.sol";

/// @notice 帳本合約的治理，用真實 Safe v1.4.1 與 OpenZeppelin Timelock 走一遍（和 DeployLedger 的移轉相同）。
///
///   · 國家 Safe 2-of-3（SOVEREIGN_ROLE）：授權金鑰清單與門檻——即時生效，重播以事件所在的區塊為起點
///   · 營運 Safe 1-of-2（OPERATOR_ROLE）：新台幣入出金、承諾提交者（COMMITTER_ROLE 的 admin）
///   · Timelock 48h（DEFAULT_ADMIN_ROLE，國家 Safe 提案與執行）：主權與營運角色本身的更換
///   · 部署者移轉之後沒有任何權限
contract LedgerGovernanceTest is Test {
    using SafeHelper for Safe;

    uint256[3] internal natPk = [uint256(0xA1), 0xA2, 0xA3];
    uint256[2] internal opPk = [uint256(0xB1), 0xB2];
    Safe internal nationalSafe;
    Safe internal operatorSafe;
    TimelockController internal timelock;
    Ledger internal ledger;
    address internal deployer = makeAddr("deployer");
    address internal committer = makeAddr("committer");

    bytes32 internal constant ADMIN = 0x00;
    bytes32 internal SOV;
    bytes32 internal OP;

    function setUp() public {
        GovernanceLib.SafeInfra memory infra = GovernanceLib.deploySafeInfra();
        address[] memory nat = new address[](3);
        for (uint256 i = 0; i < 3; i++) nat[i] = vm.addr(natPk[i]);
        address[] memory op = new address[](2);
        for (uint256 i = 0; i < 2; i++) op[i] = vm.addr(opPk[i]);
        nationalSafe = GovernanceLib.createSafe(infra, nat, 2, 1);
        operatorSafe = GovernanceLib.createSafe(infra, op, 1, 2);
        timelock = GovernanceLib.deployTimelock(48 hours, address(nationalSafe));

        vm.startPrank(deployer);
        ledger = new Ledger(deployer, deployer, deployer);
        SOV = ledger.SOVEREIGN_ROLE();
        OP = ledger.OPERATOR_ROLE();
        ledger.grantAuthority(ledger.AUTH_SOVEREIGN(), nat[0]);
        ledger.grantRole(ledger.COMMITTER_ROLE(), committer);
        // 移轉（與 DeployLedger._handover 相同）
        ledger.grantRole(SOV, address(nationalSafe));
        ledger.grantRole(OP, address(operatorSafe));
        ledger.grantRole(ADMIN, address(timelock));
        ledger.renounceRole(OP, deployer);
        ledger.renounceRole(SOV, deployer);
        ledger.renounceRole(ADMIN, deployer);
        vm.stopPrank();
    }

    function test_handover_deployerHoldsNothing() public view {
        assertFalse(ledger.hasRole(ADMIN, deployer));
        assertFalse(ledger.hasRole(SOV, deployer));
        assertFalse(ledger.hasRole(OP, deployer));
        assertTrue(ledger.hasRole(ADMIN, address(timelock)));
        assertTrue(ledger.hasRole(SOV, address(nationalSafe)));
        assertTrue(ledger.hasRole(OP, address(operatorSafe)));
    }

    function test_deployerCannotTouchAuthorities() public {
        bytes32 role = ledger.AUTH_CARBON_VERIFIER();
        vm.prank(deployer);
        vm.expectRevert();
        ledger.grantAuthority(role, deployer);
    }

    // ── 國家 Safe：授權金鑰清單與門檻 ──

    function test_nationalSafe_grantsAndRevokesAuthority() public {
        address v = makeAddr("verifier");
        bytes32 role = ledger.AUTH_CARBON_VERIFIER();
        nationalSafe.exec(_nat2(), address(ledger), abi.encodeCall(Ledger.grantAuthority, (role, v)));
        assertTrue(ledger.isAuthority(role, v));
        nationalSafe.exec(_nat2(), address(ledger), abi.encodeCall(Ledger.revokeAuthority, (role, v)));
        assertFalse(ledger.isAuthority(role, v));
    }

    function test_nationalSafe_singleSignerRejected() public {
        uint256[] memory one = new uint256[](1);
        one[0] = natPk[0];
        address v = makeAddr("verifier");
        nationalSafe.execExpectRevert(one, address(ledger), abi.encodeCall(Ledger.grantAuthority, (ledger.AUTH_CARBON_VERIFIER(), v))); // GS020
        assertFalse(ledger.isAuthority(ledger.AUTH_CARBON_VERIFIER(), v));
    }

    function test_nationalSafe_setsThreshold() public {
        bytes32 role = ledger.AUTH_SOVEREIGN();
        nationalSafe.exec(_nat2(), address(ledger), abi.encodeCall(Ledger.setThreshold, (role, 2)));
        assertEq(ledger.thresholdOf(role), 2);
    }

    // ── 營運 Safe：提領開關與承諾提交者 ──

    function test_operatorSafe_creditsDeposit() public {
        address user = makeAddr("user");
        operatorSafe.exec(_op1(), address(ledger), abi.encodeCall(Ledger.creditDeposit, (user, 1_000e6, keccak256("bank:1"))));
        assertEq(ledger.cash().balanceOf(address(ledger)), 1_000e6);
    }

    function test_deployerAndNationalSafeCannotCredit() public {
        vm.prank(deployer);
        vm.expectRevert();
        ledger.creditDeposit(deployer, 1e6, keccak256("bank:d"));
        nationalSafe.execExpectRevert(_nat2(), address(ledger), abi.encodeCall(Ledger.creditDeposit, (deployer, 1e6, keccak256("bank:n"))));
    }

    function test_operatorSafe_rotatesCommitter() public {
        address next = makeAddr("committer2");
        bytes32 role = ledger.COMMITTER_ROLE();
        operatorSafe.exec(_op1(), address(ledger), abi.encodeCall(IAccessControl.grantRole, (role, next)));
        operatorSafe.exec(_op1(), address(ledger), abi.encodeCall(IAccessControl.revokeRole, (role, committer)));
        assertTrue(ledger.hasRole(role, next));
        assertFalse(ledger.hasRole(role, committer));
    }

    function test_operatorSafe_cannotTouchAuthorities() public {
        operatorSafe.execExpectRevert(_op1(), address(ledger), abi.encodeCall(Ledger.grantAuthority, (ledger.AUTH_CARBON_VERIFIER(), address(operatorSafe))));
        operatorSafe.execExpectRevert(_op1(), address(ledger), abi.encodeCall(Ledger.setThreshold, (ledger.AUTH_SOVEREIGN(), 1)));
    }

    // ── 結構權：主權角色本身的更換必須經 Timelock 48h ──

    function test_sovereignRoleChange_requiresTimelock() public {
        address other = makeAddr("other");
        bytes memory data = abi.encodeCall(IAccessControl.grantRole, (SOV, other));
        nationalSafe.execExpectRevert(_nat2(), address(ledger), data);

        bytes32 salt = keccak256("sov");
        nationalSafe.schedule(_nat2(), timelock, address(ledger), data, salt);
        nationalSafe.executeExpectRevert(_nat2(), timelock, address(ledger), data, salt);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        nationalSafe.execute(_nat2(), timelock, address(ledger), data, salt);
        assertTrue(ledger.hasRole(SOV, other));
    }

    function test_timelock_onlyNationalSafeCanPropose() public {
        bytes memory data = abi.encodeCall(IAccessControl.grantRole, (SOV, deployer));
        vm.prank(deployer);
        vm.expectRevert();
        timelock.schedule(address(ledger), 0, data, bytes32(0), keccak256("x"), 48 hours);
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
