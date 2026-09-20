// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {CarbonRegistry} from "../src/registry/CarbonRegistry.sol";
import {CarbonCredit1155} from "../src/registry/CarbonCredit1155.sol";
import {CarbonPool} from "../src/market/CarbonPool.sol";
import {Listing} from "../src/market/Listing.sol";
import {IJurisdictions} from "../src/interfaces/IJurisdictions.sol";
import {RetirementCertificate} from "../src/registry/RetirementCertificate.sol";

/// 國別屬性與用途限制。
///
/// 這一組測試在保護一條法規上的硬界線：國外減量額度不能拿來做增量抵換或環評承諾
/// （氣候變遷因應法第 27 條只給它「扣除碳費排放量」與「抵銷超額量」兩條路）。
/// 如果哪天有人把 purposeMask 放寬成 0x0F，這裡會紅。
contract JurisdictionTest is Fixture {
    uint8 internal constant FOREIGN_MASK = 0x03; // CarbonFee | VoluntaryNeutrality

    function setUp() public override {
        super.setUp();
        vm.prank(sovereign);
        registry.setJurisdiction(
            "JP",
            IJurisdictions.Jurisdiction({
                enabled: true,
                domestic: false,
                purposeMask: FOREIGN_MASK,
                name: unicode"日本",
                scheme: "J-Credit",
                registryName: unicode"Ｊ－クレジット登録簿",
                note: unicode"三省共管"
            })
        );
    }

    function _jpBatch(uint256 amountKg, bytes32 serial) internal returns (uint256 batchId) {
        vm.prank(sovereign);
        uint256 pid = registry.registerImportedProject(
            companyB, unicode"北海道 鍋爐燃料轉換", "J-Credit / EN-S-001", "Hokkaido, JP", "ipfs://jp", "JP", "J-Credit"
        );
        batchId = _issue(pid, amountKg, serial);
    }

    function test_domesticProjectIsTaiwanByDefault() public {
        uint256 pid = _registerProject(companyA);
        CarbonRegistry.Project memory p = registry.projectOf(pid);
        assertEq(p.country, bytes2("TW"));
        assertEq(p.scheme, "TCER");
    }

    function test_importedProjectCarriesCountry() public {
        uint256 batchId = _jpBatch(5_000, keccak256("JP-1"));
        (bytes2 c, IJurisdictions.Jurisdiction memory j) =
            registry.jurisdictionOfProject(credit.batchOf(batchId).projectId);
        assertEq(c, bytes2("JP"));
        assertEq(j.scheme, "J-Credit");
        assertFalse(j.domestic);
    }

    function test_onlySovereignCanRegisterImported() public {
        vm.prank(companyA);
        vm.expectRevert();
        registry.registerImportedProject(companyA, "x", "y", "z", "u", "JP", "J-Credit");
    }

    function test_cannotRegisterUnknownJurisdiction() public {
        vm.prank(sovereign);
        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.UnknownJurisdiction.selector, bytes2("XX")));
        registry.registerImportedProject(companyA, "x", "y", "z", "u", "XX", "s");
    }

    /// 國外額度：碳費扣除可以，自願性碳中和可以。
    function test_foreignCreditAllowsCarbonFeeAndVoluntary() public {
        uint256 batchId = _jpBatch(5_000, keccak256("JP-2"));
        vm.startPrank(companyB);
        credit.retire(_req(companyB, batchId, 1_000, RetirementCertificate.Purpose.CarbonFee));
        credit.retire(_req(companyB, batchId, 1_000, RetirementCertificate.Purpose.VoluntaryNeutrality));
        vm.stopPrank();
        assertEq(credit.batchOf(batchId).retiredKg, 2_000);
    }

    /// 國外額度：增量抵換與環評承諾不行——這是法規界線，不是介面提示。
    function test_foreignCreditRejectsIncrementOffset() public {
        uint256 batchId = _jpBatch(5_000, keccak256("JP-3"));
        vm.prank(companyB);
        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.PurposeNotAllowed.selector, bytes2("JP"), uint8(2)));
        credit.retire(_req(companyB, batchId, 1_000, RetirementCertificate.Purpose.IncrementOffset));
    }

    function test_foreignCreditRejectsEiaCommitment() public {
        uint256 batchId = _jpBatch(5_000, keccak256("JP-4"));
        vm.prank(companyB);
        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.PurposeNotAllowed.selector, bytes2("JP"), uint8(3)));
        credit.retire(_req(companyB, batchId, 1_000, RetirementCertificate.Purpose.EiaCommitment));
    }

    /// 國內額度四種用途都可以。
    function test_domesticCreditAllowsIncrementOffset() public {
        uint256 pid = _registerProject(companyA);
        uint256 batchId = _issue(pid, 5_000, keccak256("TW-1"));
        vm.prank(companyA);
        credit.retire(_req(companyA, batchId, 1_000, RetirementCertificate.Purpose.IncrementOffset));
        assertEq(credit.batchOf(batchId).retiredKg, 1_000);
    }

    /// 憑證要寫明是哪一國、哪一個機制的額度。
    function test_certificateRecordsCountry() public {
        uint256 batchId = _jpBatch(5_000, keccak256("JP-5"));
        vm.prank(companyB);
        uint256 certId = credit.retire(_req(companyB, batchId, 1_000, RetirementCertificate.Purpose.CarbonFee));
        RetirementCertificate.Certificate memory c = cert.certificateOf(certId);
        assertEq(c.country, bytes2("JP"));
        assertEq(c.scheme, "J-Credit");
    }

    /// 轄區關掉之後不能再上架，但既有持有不受影響（流動性可以停，持有不能沒收）。
    function test_disabledJurisdictionCannotList() public {
        uint256 batchId = _jpBatch(5_000, keccak256("JP-6"));
        vm.prank(sovereign);
        registry.setJurisdiction(
            "JP",
            IJurisdictions.Jurisdiction({
                enabled: false,
                domestic: false,
                purposeMask: FOREIGN_MASK,
                name: unicode"日本",
                scheme: "J-Credit",
                registryName: unicode"Ｊ－クレジット登録簿",
                note: unicode"暫停"
            })
        );
        vm.startPrank(companyB);
        credit.setApprovalForAll(address(listing), true);
        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.JurisdictionDisabled.selector, bytes2("JP")));
        listing.list(batchId, 1_000, 800e6, 100);
        // 轉讓仍然可以：使用者的持有不因政策變動而被凍結
        credit.safeTransferFrom(companyB, companyA, batchId, 1_000, "");
        vm.stopPrank();
        assertEq(credit.balanceOf(companyA, batchId), 1_000);
    }

    /// 池化只收國內額度：CCT 是同質的，混進國外額度會讓 FIFO 贖回變成抽籤決定「哪一國」。
    function test_poolRejectsForeignCredit() public {
        uint256 batchId = _jpBatch(5_000, keccak256("JP-7"));
        vm.startPrank(companyB);
        credit.setApprovalForAll(address(pool), true);
        vm.expectRevert(abi.encodeWithSelector(CarbonPool.NotDomestic.selector, bytes2("JP")));
        pool.deposit(batchId, 1_000);
        vm.stopPrank();
    }

    function _req(address holder, uint256 batchId, uint256 kg, RetirementCertificate.Purpose p)
        internal
        pure
        returns (CarbonCredit1155.RetireRequest memory)
    {
        return CarbonCredit1155.RetireRequest({
            holder: holder,
            batchId: batchId,
            amountKg: kg,
            certificateTo: holder,
            beneficiaryHash: keccak256("b"),
            beneficiary: "B",
            purpose: p,
            memo: ""
        });
    }
}
