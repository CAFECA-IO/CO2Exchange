// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {CarbonPool} from "../src/market/CarbonPool.sol";
import {RetirementCertificate} from "../src/registry/RetirementCertificate.sol";
import {IKYCRegistry} from "../src/interfaces/IKYCRegistry.sol";

contract PoolTest is Fixture {
    uint256 internal batch1;
    uint256 internal batch2;

    function setUp() public override {
        super.setUp();
        uint256 pid = _registerProject(companyA);
        batch1 = _issue(pid, 3_000, keccak256("P1"));
        batch2 = _issue(pid, 3_000, keccak256("P2"));
        vm.prank(companyA);
        credit.setApprovalForAll(address(pool), true);
    }

    function test_deposit_mintsCct() public {
        vm.prank(companyA);
        pool.deposit(batch1, 3_000);
        assertEq(cct.balanceOf(companyA), 3e18);
        assertEq(pool.pooledKg(batch1), 3_000);
    }

    function test_deposit_rejectsWrongVintage() public {
        // 核發一批 2024 年的額度
        uint256 pid = _registerProject(companyA);
        CarbonRegistryIssue memory i = CarbonRegistryIssue(pid, 1704067200, 1735603200, 1000, keccak256("OLD"));
        uint256 oldBatch = _issueWithPeriod(i);
        vm.prank(companyA);
        vm.expectRevert(abi.encodeWithSelector(CarbonPool.VintageMismatch.selector, uint16(2025), uint16(2024)));
        pool.deposit(oldBatch, 1000);
    }

    function test_individualCannotDeposit() public {
        vm.prank(companyA);
        credit.safeTransferFrom(companyA, alice, batch1, 1000, "");
        vm.startPrank(alice);
        credit.setApprovalForAll(address(pool), true);
        vm.expectRevert(abi.encodeWithSelector(CarbonPool.NotCorporate.selector, alice));
        pool.deposit(batch1, 1000);
        vm.stopPrank();
    }

    function test_redeem_isFifoAcrossBatches() public {
        vm.startPrank(companyA);
        pool.deposit(batch1, 3_000);
        pool.deposit(batch2, 3_000);
        cct.transfer(companyB, 4e18);
        vm.stopPrank();

        vm.prank(companyB);
        (uint256[] memory ids, uint256[] memory amounts) = pool.redeem(4_000);
        assertEq(ids.length, 2);
        assertEq(ids[0], batch1);
        assertEq(amounts[0], 3_000);
        assertEq(ids[1], batch2);
        assertEq(amounts[1], 1_000);
        assertEq(credit.balanceOf(companyB, batch1), 3_000);
        assertEq(credit.balanceOf(companyB, batch2), 1_000);
        assertEq(cct.balanceOf(companyB), 0);
        assertEq(pool.queueLength(), 1);
    }

    function test_redeemSpecific_chargesFee() public {
        vm.startPrank(companyA);
        pool.deposit(batch1, 3_000);
        pool.deposit(batch2, 3_000);
        cct.transfer(companyB, 3e18);
        vm.stopPrank();

        vm.prank(companyB);
        pool.redeemSpecific(batch2, 2_000); // 2 CCT + 5% fee = 0.1 CCT
        assertEq(credit.balanceOf(companyB, batch2), 2_000);
        assertEq(cct.balanceOf(companyB), 0.9e18);
        assertEq(cct.balanceOf(treasury), 0.1e18);
        // 1:1 backing：總供給 == 池內 kg * 1e15
        assertEq(cct.totalSupply(), (pool.pooledKg(batch1) + pool.pooledKg(batch2)) * 1e15);
    }

    function test_redeemAndRetire_individualPath() public {
        vm.startPrank(companyA);
        pool.deposit(batch1, 3_000);
        vm.stopPrank();
        // 模擬 alice 從市場買到 CCT（系統合約 → 自然人）
        vm.prank(sovereign);
        kyc.setSystemContract(companyA, true); // 測試便利：讓 companyA 可轉給自然人
        vm.prank(companyA);
        cct.transfer(alice, 1.5e18);

        vm.prank(alice);
        uint256[] memory certs =
            pool.redeemAndRetire(1_500, keccak256("alice"), "Alice", RetirementCertificate.Purpose.Voluntary, "");
        assertEq(certs.length, 1);
        assertEq(cert.ownerOf(certs[0]), alice);
        assertEq(cert.certificateOf(certs[0]).amountKg, 1_500);
        assertEq(cct.balanceOf(alice), 0);
        assertEq(credit.batchOf(batch1).retiredKg, 1_500);
        assertEq(pool.pooledKg(batch1), 1_500);
    }

    function test_redeem_insufficientLiquidity() public {
        vm.prank(companyA);
        pool.deposit(batch1, 1_000);
        vm.prank(companyA);
        vm.expectRevert(CarbonPool.InsufficientLiquidity.selector);
        pool.redeem(2_000);
    }

    // ── helpers ──
    struct CarbonRegistryIssue {
        uint256 projectId;
        uint64 start;
        uint64 end;
        uint256 kg;
        bytes32 serial;
    }

    function _issueWithPeriod(CarbonRegistryIssue memory i) internal returns (uint256) {
        CarbonRegistry.IssuanceAttestation memory a = CarbonRegistry.IssuanceAttestation({
            projectId: i.projectId,
            monitoringStart: i.start,
            monitoringEnd: i.end,
            amountKg: i.kg,
            serialHash: i.serial,
            reportHash: keccak256("r"),
            attestationId: uint256(i.serial),
            deadline: block.timestamp + 1 days
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(carbonVerifierPk, registry.hashIssuance(a));
        return registry.issue(a, abi.encodePacked(r, s, v));
    }
}

import {CarbonRegistry} from "../src/registry/CarbonRegistry.sol";
