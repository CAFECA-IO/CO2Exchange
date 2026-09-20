// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {Listing} from "../src/market/Listing.sol";
import {IKYCRegistry} from "../src/interfaces/IKYCRegistry.sol";

contract ListingTest is Fixture {
    uint256 internal batch;

    function setUp() public override {
        super.setUp();
        uint256 pid = _registerProject(companyA);
        batch = _issue(pid, 10_000, keccak256("L1")); // 10 噸
        vm.prank(companyA);
        credit.setApprovalForAll(address(listing), true);
    }

    function test_listAndBuy_individual() public {
        vm.prank(companyA);
        uint256 orderId = listing.list(batch, 10_000, 800e6, 100); // 800 mTWD / 噸

        vm.startPrank(alice);
        twd.approve(address(listing), type(uint256).max);
        listing.buy(orderId, 2_500); // 2.5 噸 → 2000 mTWD，1% fee = 20
        vm.stopPrank();

        assertEq(credit.balanceOf(alice, batch), 2_500);
        assertEq(credit.balanceOf(address(listing), batch), 7_500);
        assertEq(twd.balanceOf(companyA), 1980e6);
        assertEq(twd.balanceOf(treasury), 20e6);
        assertEq(listing.orderOf(orderId).remainingKg, 7_500);
    }

    function test_buy_lastFillIgnoresMinFill() public {
        vm.prank(companyA);
        uint256 orderId = listing.list(batch, 1_000, 800e6, 600);
        vm.startPrank(alice);
        twd.approve(address(listing), type(uint256).max);
        listing.buy(orderId, 600);
        listing.buy(orderId, 400); // 剩餘 400 < minFill，但為最後一筆 → 允許
        vm.stopPrank();
        assertFalse(listing.orderOf(orderId).active);
    }

    function test_buy_belowMinFillRejected() public {
        vm.prank(companyA);
        uint256 orderId = listing.list(batch, 1_000, 800e6, 600);
        vm.startPrank(alice);
        twd.approve(address(listing), type(uint256).max);
        vm.expectRevert(Listing.BelowMinFill.selector);
        listing.buy(orderId, 100);
        vm.stopPrank();
    }

    /// 自然人可以轉售：他無法註銷，轉售是唯一的出場方式。
    /// 掛單不再檢查法人身分，能不能轉出由身分層（checkTransfer）決定。
    function test_individualCanList() public {
        vm.prank(companyA);
        credit.safeTransferFrom(companyA, alice, batch, 1000, "");
        vm.startPrank(alice);
        credit.setApprovalForAll(address(listing), true);
        uint256 orderId = listing.list(batch, 1000, 900e6, 0);
        vm.stopPrank();
        assertEq(listing.orderOf(orderId).seller, alice);
        assertEq(credit.balanceOf(address(listing), batch), 1000);

        // 主權角色關掉自然人轉出之後，掛單也跟著擋下——規則只有一處
        vm.prank(sovereign);
        kyc.setIndividualTransferEnabled(false);
        vm.prank(companyA);
        credit.safeTransferFrom(companyA, alice, batch, 500, "");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.IndividualTransferDisabled.selector, alice));
        listing.list(batch, 500, 900e6, 0);
    }

    function test_unverifiedCannotList() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Listing.NotActiveAccount.selector, stranger));
        listing.list(batch, 1000, 800e6, 0);
    }

    function test_unverifiedCannotBuy() public {
        vm.prank(companyA);
        uint256 orderId = listing.list(batch, 1_000, 800e6, 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Listing.NotActiveAccount.selector, stranger));
        listing.buy(orderId, 100);
    }

    function test_cancel_returnsRemaining() public {
        vm.prank(companyA);
        uint256 orderId = listing.list(batch, 1_000, 800e6, 0);
        vm.prank(companyA);
        listing.cancel(orderId);
        assertEq(credit.balanceOf(companyA, batch), 10_000);
        assertFalse(listing.orderOf(orderId).active);
    }

    function test_pause_blocksTrading() public {
        vm.prank(operator);
        listing.pause();
        vm.prank(companyA);
        vm.expectRevert();
        listing.list(batch, 1_000, 800e6, 0);
    }

    function test_feeCapEnforced() public {
        vm.prank(operator);
        vm.expectRevert(Listing.FeeTooHigh.selector);
        listing.setFee(501, treasury);
    }
}
