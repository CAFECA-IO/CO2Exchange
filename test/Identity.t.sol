// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {IKYCRegistry} from "../src/interfaces/IKYCRegistry.sol";
import {KYCRegistry} from "../src/identity/KYCRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract IdentityTest is Fixture {
    function test_register_setsIdentity() public view {
        IKYCRegistry.Identity memory id = kyc.identityOf(companyA);
        assertEq(uint8(id.tier), uint8(IKYCRegistry.Tier.Corporate));
        assertEq(id.jurisdiction, bytes2("TW"));
        assertTrue(kyc.isActive(companyA));
        assertFalse(kyc.isActive(stranger));
    }

    function test_register_rejectsUnknownSigner() public {
        KYCRegistry.IdentityAttestation memory a = KYCRegistry.IdentityAttestation({
            account: stranger,
            tier: IKYCRegistry.Tier.Individual,
            expiry: uint64(vm.getBlockTimestamp() + 1 days),
            jurisdiction: bytes2("TW"),
            identityHash: keccak256("x"),
            nonce: 0,
            deadline: vm.getBlockTimestamp() + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xDEAD, kyc.hashAttestation(a));
        vm.expectRevert(KYCRegistry.InvalidAttestation.selector);
        kyc.register(a, abi.encodePacked(r, s, v));
    }

    function test_register_replayRejected() public {
        (KYCRegistry.IdentityAttestation memory a, bytes memory sig) =
            _attest(stranger, IKYCRegistry.Tier.Individual, keccak256("s"), uint64(vm.getBlockTimestamp() + 1 days));
        kyc.register(a, sig);
        vm.expectRevert(KYCRegistry.InvalidAttestation.selector);
        kyc.register(a, sig);
    }

    function test_expiry_blocksTransferButNotRetire() public {
        uint256 pid = _registerProject(companyA);
        uint256 batch = _issue(pid, 5000, keccak256("S1"));

        vm.warp(vm.getBlockTimestamp() + 366 days); // companyA KYC 到期
        assertFalse(kyc.isActive(companyA));

        vm.prank(companyA);
        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.NotActive.selector, companyA));
        credit.safeTransferFrom(companyA, companyB, batch, 1000, "");

        // 到期仍可註銷
        vm.prank(companyA);
        credit.retire(_retireReq(companyA, batch, 1000, companyA));
        assertEq(credit.balanceOf(companyA, batch), 4000);
    }

    function test_freeze_blocksEverything() public {
        uint256 pid = _registerProject(companyA);
        uint256 batch = _issue(pid, 5000, keccak256("S1"));
        vm.prank(sovereign);
        kyc.setFrozen(companyA, true);

        vm.prank(companyA);
        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.Frozen.selector, companyA));
        credit.safeTransferFrom(companyA, companyB, batch, 1000, "");

        vm.prank(companyA);
        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.Frozen.selector, companyA));
        credit.retire(_retireReq(companyA, batch, 1000, companyA));
    }

    /// 自然人可以轉售、但不能註銷。
    ///
    /// 理由在官方制度那一端：自然人開不了額度帳戶（交易拍賣及移轉管理辦法第 2 條第 1 款的
    /// 「事業」不含自然人，第 7 條開戶要檢附設立登記證明），所以他不可能受領官方移轉、
    /// 也不可能在官方登錄簿註銷。他手上的本來就是請求權——請求權轉給別人沒問題，
    /// 但讓他在鏈上註銷，會生出一張官方端對不到任何紀錄的憑證。
    function test_individual_canTransfer_cannotRetire() public {
        uint256 pid = _registerProject(companyA);
        uint256 batch = _issue(pid, 5000, keccak256("S1"));
        vm.prank(companyA);
        credit.safeTransferFrom(companyA, alice, batch, 1000, "");

        // 轉售：預設允許
        vm.prank(alice);
        credit.safeTransferFrom(alice, companyB, batch, 500, "");
        assertEq(credit.balanceOf(companyB, batch), 500);

        // 註銷：擋下
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.IndividualRetireDisabled.selector, alice));
        credit.retire(_retireReq(alice, batch, 100, alice));

        // 法人註銷沒問題
        vm.prank(companyB);
        credit.retire(_retireReq(companyB, batch, 100, companyB));

        // 主管機關若開放自然人帳戶，主權角色打開開關即可
        vm.prank(sovereign);
        kyc.setIndividualRetireEnabled(true);
        vm.prank(alice);
        credit.retire(_retireReq(alice, batch, 100, alice));
        assertEq(cert.balanceOf(alice), 1);

        // 反向：主權角色也可以關掉自然人轉售
        vm.prank(sovereign);
        kyc.setIndividualTransferEnabled(false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.IndividualTransferDisabled.selector, alice));
        credit.safeTransferFrom(alice, companyB, batch, 100, "");
    }

    function test_recover_movesBalancesAndIdentity() public {
        uint256 pid = _registerProject(companyA);
        uint256 batch = _issue(pid, 5000, keccak256("S1"));
        vm.prank(companyA);
        credit.setApprovalForAll(address(pool), true);
        vm.prank(companyA);
        pool.deposit(batch, 2000);
        assertEq(cct.balanceOf(companyA), 2e18);

        address companyANew = makeAddr("companyA-new");
        (KYCRegistry.IdentityAttestation memory a, bytes memory sig) = _attest(
            companyANew, IKYCRegistry.Tier.Corporate, keccak256("TW-12345678"), uint64(vm.getBlockTimestamp() + 365 days)
        );

        // 只有 OPERATOR 可執行
        vm.expectRevert();
        kyc.recover(companyA, a, sig);

        vm.prank(operator);
        kyc.recover(companyA, a, sig);

        assertEq(credit.balanceOf(companyA, batch), 0);
        assertEq(credit.balanceOf(companyANew, batch), 3000);
        assertEq(cct.balanceOf(companyANew), 2e18);
        assertTrue(kyc.isActive(companyANew));
        assertFalse(kyc.isActive(companyA));
        assertTrue(kyc.identityOf(companyA).frozen);
    }

    function test_recover_rejectsDifferentIdentityHash() public {
        address other = makeAddr("other");
        (KYCRegistry.IdentityAttestation memory a, bytes memory sig) =
            _attest(other, IKYCRegistry.Tier.Corporate, keccak256("someone-else"), uint64(vm.getBlockTimestamp() + 365 days));
        vm.prank(operator);
        vm.expectRevert(KYCRegistry.IdentityMismatch.selector);
        kyc.recover(companyA, a, sig);
    }
}
