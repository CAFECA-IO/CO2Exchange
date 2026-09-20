// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {Listing} from "../src/market/Listing.sol";
import {IKYCRegistry} from "../src/interfaces/IKYCRegistry.sol";
import {IJurisdictions} from "../src/interfaces/IJurisdictions.sol";

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

    // ───────────────────────── 買單 ─────────────────────────

    /// JP 轄區預設沒開，要測「核發國不符」得先開起來
    function _enableJp() internal {
        vm.prank(sovereign);
        registry.setJurisdiction(
            "JP",
            IJurisdictions.Jurisdiction({
                enabled: true,
                domestic: false,
                purposeMask: uint8((1 << 0) | (1 << 1)), // 碳費 + 自願性碳中和
                name: unicode"日本",
                scheme: "J-Credit",
                registryName: unicode"Ｊ－クレジット登録簿",
                note: unicode"僅可扣除碳費排放量與自願性碳中和"
            })
        );
    }

    function test_placeBid_escrowsCash() public {
        uint256 before = twd.balanceOf(companyB);
        vm.startPrank(companyB);
        twd.approve(address(listing), type(uint256).max);
        uint256 bidId = listing.placeBid(bytes2("TW"), 5_000, 700e6, 0); // 5 噸 × 700
        vm.stopPrank();
        // 錢當場鎖進合約，不是等成交才拿——買單是對市場的承諾，要有擔保
        assertEq(twd.balanceOf(companyB), before - 3500e6);
        assertEq(twd.balanceOf(address(listing)), 3500e6);
        assertEq(listing.bidOf(bidId).remainingKg, 5_000);
    }

    function test_fillBid_sellerPaysFee() public {
        vm.startPrank(companyB);
        twd.approve(address(listing), type(uint256).max);
        uint256 bidId = listing.placeBid(bytes2("TW"), 5_000, 800e6, 0);
        vm.stopPrank();

        uint256 sellerBefore = twd.balanceOf(companyA);
        vm.prank(companyA);
        listing.fillBid(bidId, batch, 2_500); // 2.5 噸 → 2000，1% fee = 20

        assertEq(credit.balanceOf(companyB, batch), 2_500);
        assertEq(twd.balanceOf(companyA), sellerBefore + 1980e6, unicode"手續費由賣方承擔，與 buy() 同一套規則");
        assertEq(twd.balanceOf(treasury), 20e6);
        assertEq(listing.bidOf(bidId).remainingKg, 2_500);
    }

    function test_fillBid_rejectsWrongCountry() public {
        // 國外專案（JP）核發的批次，不能拿去成交一張指定 TW 的買單
        _enableJp();
        vm.prank(sovereign);
        uint256 jpPid = registry.registerImportedProject(companyA, "JP", "m", "l", "u", "JP", "J-Credit");
        uint256 jpBatch = _issue(jpPid, 10_000, keccak256("L-JP"));

        vm.startPrank(companyB);
        twd.approve(address(listing), type(uint256).max);
        uint256 bidId = listing.placeBid(bytes2("TW"), 5_000, 800e6, 0);
        vm.stopPrank();

        vm.prank(companyA);
        vm.expectRevert(abi.encodeWithSelector(Listing.CountryMismatch.selector, bytes2("TW"), bytes2("JP")));
        listing.fillBid(bidId, jpBatch, 1_000);
    }

    function test_fillBid_anyCountryWhenUnspecified() public {
        _enableJp();
        vm.prank(sovereign);
        uint256 jpPid = registry.registerImportedProject(companyA, "JP", "m", "l", "u", "JP", "J-Credit");
        uint256 jpBatch = _issue(jpPid, 10_000, keccak256("L-JP2"));

        vm.startPrank(companyB);
        twd.approve(address(listing), type(uint256).max);
        uint256 bidId = listing.placeBid(bytes2(0), 5_000, 800e6, 0); // 不限核發國
        vm.stopPrank();

        vm.prank(companyA);
        listing.fillBid(bidId, jpBatch, 1_000);
        assertEq(credit.balanceOf(companyB, jpBatch), 1_000);
    }

    function test_cancelBid_refundsRemainder() public {
        uint256 before = twd.balanceOf(companyB);
        vm.startPrank(companyB);
        twd.approve(address(listing), type(uint256).max);
        uint256 bidId = listing.placeBid(bytes2("TW"), 5_000, 800e6, 0);
        vm.stopPrank();

        vm.prank(companyA);
        listing.fillBid(bidId, batch, 1_000); // 吃掉 1 噸

        vm.prank(companyB);
        listing.cancelBid(bidId);

        // 只留下成交掉的那 1 噸的錢（800），其餘退回
        assertEq(twd.balanceOf(companyB), before - 800e6);
        assertEq(twd.balanceOf(address(listing)), 0);
        assertFalse(listing.bidOf(bidId).active);
    }

    function test_cancelBid_onlyBuyer() public {
        vm.startPrank(companyB);
        twd.approve(address(listing), type(uint256).max);
        uint256 bidId = listing.placeBid(bytes2("TW"), 1_000, 800e6, 0);
        vm.stopPrank();
        vm.prank(companyA);
        vm.expectRevert(Listing.NotBuyer.selector);
        listing.cancelBid(bidId);
    }

    function test_fillBid_cannotFillOwnBid() public {
        vm.prank(operator);
        twd.mint(companyA, 10_000e6);
        vm.startPrank(companyA);
        twd.approve(address(listing), type(uint256).max);
        uint256 bidId = listing.placeBid(bytes2("TW"), 1_000, 800e6, 0);
        vm.expectRevert(Listing.CannotFillOwnBid.selector);
        listing.fillBid(bidId, batch, 1_000);
        vm.stopPrank();
    }

    function test_fillBid_minFill() public {
        vm.startPrank(companyB);
        twd.approve(address(listing), type(uint256).max);
        uint256 bidId = listing.placeBid(bytes2("TW"), 5_000, 800e6, 2_000);
        vm.stopPrank();
        vm.prank(companyA);
        vm.expectRevert(Listing.BelowMinFill.selector);
        listing.fillBid(bidId, batch, 1_000);
        // 但「剩下的全吃」永遠允許，否則尾數會永遠卡在簿子上
        vm.prank(companyA);
        listing.fillBid(bidId, batch, 5_000);
        assertFalse(listing.bidOf(bidId).active);
    }

    function test_placeBid_requiresActiveAccount() public {
        address nobody = makeAddr("nobody");
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSelector(Listing.NotActiveAccount.selector, nobody));
        listing.placeBid(bytes2("TW"), 1_000, 800e6, 0);
    }

    /// 不變式：合約手上的錢，必須剛好等於所有有效買單還鎖著的總和。
    /// 一毛都不能多——多出來的就是沒有人領得走的餘數。
    function test_bidEscrow_noDustLeftBehind() public {
        vm.startPrank(companyB);
        twd.approve(address(listing), type(uint256).max);
        // 刻意挑會除不盡的數量與單價：333 公斤 × 777.777777 → 259.999… 捨去
        uint256 b1 = listing.placeBid(bytes2("TW"), 333, 777_777_777, 0);
        uint256 b2 = listing.placeBid(bytes2("TW"), 1_777, 333_333_333, 0);
        vm.stopPrank();

        uint256 escrowed = listing.bidOf(b1).escrow + listing.bidOf(b2).escrow;
        assertEq(twd.balanceOf(address(listing)), escrowed, unicode"掛單後：合約餘額＝託管總和");

        // 部分成交
        vm.prank(companyA);
        listing.fillBid(b1, batch, 111);
        assertEq(
            twd.balanceOf(address(listing)),
            listing.bidOf(b1).escrow + listing.bidOf(b2).escrow,
            unicode"部分成交後仍然相等"
        );

        // 全部成交：捨去的餘數要退回買方，不能留在合約裡
        vm.prank(companyA);
        listing.fillBid(b1, batch, 222);
        assertFalse(listing.bidOf(b1).active);
        assertEq(listing.bidOf(b1).escrow, 0, unicode"全部成交後這張單不再鎖著任何錢");
        assertEq(twd.balanceOf(address(listing)), listing.bidOf(b2).escrow, unicode"只剩另一張單的託管");

        // 取消剩下那張，合約應該歸零
        vm.prank(companyB);
        listing.cancelBid(b2);
        assertEq(twd.balanceOf(address(listing)), 0, unicode"全部結清後合約不留一毛錢");
    }
}
