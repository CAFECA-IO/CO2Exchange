// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {FeeSchedule} from "../src/market/FeeSchedule.sol";
import {CarbonCredit1155} from "../src/registry/CarbonCredit1155.sol";
import {RetirementCertificate} from "../src/registry/RetirementCertificate.sol";
import {IJurisdictions} from "../src/interfaces/IJurisdictions.sol";

/// 各國費率：交易手續費（bps）與註銷手續費（每公噸固定金額）可以逐一轄區設定。
contract FeeScheduleTest is Fixture {
    FeeSchedule internal fees;
    uint256 internal twBatch;
    uint256 internal jpBatch;

    function setUp() public override {
        super.setUp();

        fees = new FeeSchedule(sovereign, sovereign, operator, twd, treasury, 100, 0);
        bytes32 pricing = fees.PRICING_ROLE();
        bytes32 collector = fees.COLLECTOR_ROLE();
        vm.prank(operator);
        fees.grantRole(pricing, operator);
        vm.prank(sovereign);
        fees.grantRole(collector, address(credit));
        vm.prank(operator);
        listing.setFeeSchedule(fees); // Listing 的費率設定屬營運權
        vm.startPrank(sovereign);
        credit.setFeeSchedule(address(fees));
        registry.setJurisdiction(
            "JP",
            IJurisdictions.Jurisdiction({
                enabled: true, domestic: false, purposeMask: 0x03,
                name: unicode"日本", scheme: "J-Credit", registryName: "JCR", note: ""
            })
        );
        vm.stopPrank();

        twBatch = _issue(_registerProject(companyA), 10_000, keccak256("TW-F1"));
        vm.prank(sovereign);
        uint256 jpPid = registry.registerImportedProject(companyA, "JP", "m", "l", "u", "JP", "J-Credit");
        jpBatch = _issue(jpPid, 10_000, keccak256("JP-F1"));

        vm.prank(operator);
        twd.mint(companyB, 1_000_000e6);
        vm.prank(companyA);
        credit.setApprovalForAll(address(listing), true);
    }

    function _list(uint256 batchId) internal returns (uint256) {
        vm.prank(companyA);
        return listing.list(batchId, 5_000, 1_000e6, 100);
    }

    function test_defaultFeeApplies() public {
        assertEq(listing.feeBpsOf(twBatch), 100);
        assertEq(listing.feeBpsOf(jpBatch), 100);
    }

    /// 國外額度的跨境作業成本較高，交易費可以單獨調高，不影響國內。
    function test_countryTradeFeeOverride() public {
        vm.prank(operator);
        fees.setCountryFee("JP", true, 250, 0);
        assertEq(listing.feeBpsOf(jpBatch), 250);
        assertEq(listing.feeBpsOf(twBatch), 100, unicode"國內費率不該被連動");

        uint256 orderId = _list(jpBatch);
        uint256 before = twd.balanceOf(treasury);
        vm.startPrank(companyB);
        twd.approve(address(listing), type(uint256).max);
        listing.buy(orderId, 1_000); // 1 噸 × 1000 mTWD = 1000e6，2.5% = 25e6
        vm.stopPrank();
        assertEq(twd.balanceOf(treasury) - before, 25e6);
    }

    function test_clearCountryFeeFallsBackToDefault() public {
        vm.startPrank(operator);
        fees.setCountryFee("JP", true, 250, 7e6);
        fees.setCountryFee("JP", false, 0, 0);
        vm.stopPrank();
        assertEq(listing.feeBpsOf(jpBatch), 100);
        assertEq(fees.retireFeePerTonneOf("JP"), 0);
    }

    /// 註銷手續費按公噸計，不看市價——代辦一次官方註銷的成本跟當天行情無關。
    function test_retireFeePerTonne() public {
        vm.prank(operator);
        fees.setCountryFee("JP", true, 100, 40e6); // 每噸 40 mTWD

        vm.prank(companyA);
        credit.safeTransferFrom(companyA, companyB, jpBatch, 3_000, "");
        vm.startPrank(companyB);
        twd.approve(address(fees), type(uint256).max);
        uint256 before = twd.balanceOf(treasury);
        credit.retire(CarbonCredit1155.RetireRequest({
            holder: companyB, batchId: jpBatch, amountKg: 3_000, certificateTo: companyB,
            beneficiaryHash: keccak256("b"), beneficiary: "B",
            purpose: RetirementCertificate.Purpose.CarbonFee, memo: ""
        }));
        vm.stopPrank();
        assertEq(twd.balanceOf(treasury) - before, 120e6, unicode"3 噸 × 40 = 120");
    }

    /// 預設為 0：Phase 0 不收註銷手續費，收不收是營運決定，不是合約寫死的。
    function test_zeroRetireFeeTakesNothing() public {
        uint256 before = twd.balanceOf(treasury);
        vm.prank(companyA);
        credit.retire(CarbonCredit1155.RetireRequest({
            holder: companyA, batchId: twBatch, amountKg: 1_000, certificateTo: companyA,
            beneficiaryHash: keccak256("b"), beneficiary: "A",
            purpose: RetirementCertificate.Purpose.CarbonFee, memo: ""
        }));
        assertEq(twd.balanceOf(treasury), before);
    }

    function test_feeCapEnforced() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeSchedule.FeeTooHigh.selector, uint16(501)));
        fees.setCountryFee("JP", true, 501, 0);
    }

    function test_onlyPricingRoleCanSet() public {
        vm.prank(companyA);
        vm.expectRevert();
        fees.setCountryFee("JP", true, 200, 0);
    }

    /// 只有額度合約能要求收費，其他人不行。
    function test_onlyCollectorCanCollect() public {
        vm.prank(companyA);
        vm.expectRevert();
        fees.collectRetireFee(companyB, "TW", 1000);
    }
}
