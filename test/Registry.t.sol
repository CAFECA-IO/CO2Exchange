// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {CarbonRegistry} from "../src/registry/CarbonRegistry.sol";
import {CarbonCredit1155} from "../src/registry/CarbonCredit1155.sol";
import {RetirementCertificate} from "../src/registry/RetirementCertificate.sol";

contract RegistryTest is Fixture {
    function test_registerProject_requiresCorporate() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.NotCorporate.selector, alice));
        registry.registerProject("x", "y", "z", "");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.NotCorporate.selector, stranger));
        registry.registerProject("x", "y", "z", "");
    }

    function test_issue_mintsToProjectOwnerWithMetadata() public {
        uint256 pid = _registerProject(companyA);
        uint256 batch = _issue(pid, 12_000, keccak256("VERRA-TW-0001-0012"));

        assertEq(credit.balanceOf(companyA, batch), 12_000);
        CarbonCredit1155.Batch memory b = credit.batchOf(batch);
        assertEq(b.projectId, pid);
        assertEq(b.vintageYear, 2025);
        assertEq(b.verifier, carbonVerifier);
        assertEq(b.issuedKg, 12_000);
        assertEq(b.retiredKg, 0);
        assertTrue(registry.serialUsed(keccak256("VERRA-TW-0001-0012")));
    }

    function test_issue_rejectsDuplicateSerial() public {
        uint256 pid = _registerProject(companyA);
        _issue(pid, 1000, keccak256("DUP"));
        (CarbonRegistry.IssuanceAttestation memory a, bytes memory sig) = _signIssue(pid, 1000, keccak256("DUP"));
        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.SerialAlreadyUsed.selector, keccak256("DUP")));
        registry.issue(a, sig);
    }

    function test_issue_rejectsRevokedVerifier() public {
        uint256 pid = _registerProject(companyA);
        vm.prank(sovereign);
        registry.revokeVerifier(carbonVerifier);
        (CarbonRegistry.IssuanceAttestation memory a, bytes memory sig) = _signIssue(pid, 1000, keccak256("S"));
        vm.expectRevert(CarbonRegistry.InvalidAttestation.selector);
        registry.issue(a, sig);
    }

    function test_issue_rejectsInactiveProject() public {
        uint256 pid = _registerProject(companyA);
        vm.prank(sovereign);
        registry.setProjectActive(pid, false);
        (CarbonRegistry.IssuanceAttestation memory a, bytes memory sig) = _signIssue(pid, 1000, keccak256("S"));
        vm.expectRevert(abi.encodeWithSelector(CarbonRegistry.ProjectInactive.selector, pid));
        registry.issue(a, sig);
    }

    function test_retire_burnsAndMintsSoulboundCertificate() public {
        uint256 pid = _registerProject(companyA);
        uint256 batch = _issue(pid, 5000, keccak256("S1"));

        vm.prank(companyA);
        uint256 certId = credit.retire(_retireReq(companyA, batch, 1500, companyA));

        assertEq(credit.balanceOf(companyA, batch), 3500);
        assertEq(credit.batchOf(batch).retiredKg, 1500);
        assertEq(cert.ownerOf(certId), companyA);
        RetirementCertificate.Certificate memory c = cert.certificateOf(certId);
        assertEq(c.batchId, batch);
        assertEq(c.amountKg, 1500);
        assertEq(uint8(c.purpose), uint8(RetirementCertificate.Purpose.CarbonFeeOffset));
        assertEq(c.retiredBy, companyA);

        // soulbound
        vm.prank(companyA);
        vm.expectRevert(RetirementCertificate.Soulbound.selector);
        cert.transferFrom(companyA, companyB, certId);

        // operator 寫回正式 PDF hash
        vm.prank(operator);
        cert.setDocumentHash(certId, keccak256("pdf"));
        assertEq(cert.certificateOf(certId).documentHash, keccak256("pdf"));
        assertGt(bytes(cert.tokenURI(certId)).length, 0);
    }

    function test_retire_requiresApprovalForThirdParty() public {
        uint256 pid = _registerProject(companyA);
        uint256 batch = _issue(pid, 5000, keccak256("S1"));
        vm.prank(companyB);
        vm.expectRevert(CarbonCredit1155.NotAuthorized.selector);
        credit.retire(_retireReq(companyA, batch, 100, companyB));
    }

    function test_retire_certificateRecipientMustBeKnown() public {
        uint256 pid = _registerProject(companyA);
        uint256 batch = _issue(pid, 5000, keccak256("S1"));
        vm.prank(companyA);
        vm.expectRevert();
        credit.retire(_retireReq(companyA, batch, 100, stranger));
    }

    function test_frozenBatch_blocksTransferAndRetire() public {
        uint256 pid = _registerProject(companyA);
        uint256 batch = _issue(pid, 5000, keccak256("S1"));
        vm.prank(sovereign);
        credit.setBatchFrozen(batch, true);

        vm.prank(companyA);
        vm.expectRevert(abi.encodeWithSelector(CarbonCredit1155.BatchIsFrozen.selector, batch));
        credit.safeTransferFrom(companyA, companyB, batch, 100, "");

        vm.prank(companyA);
        vm.expectRevert(abi.encodeWithSelector(CarbonCredit1155.BatchIsFrozen.selector, batch));
        credit.retire(_retireReq(companyA, batch, 100, companyA));
    }

    function test_onlyRegistryCanIssue() public {
        CarbonCredit1155.Batch memory b;
        b.issuedKg = 1;
        vm.expectRevert(CarbonCredit1155.OnlyRegistry.selector);
        credit.issue(companyA, b);
    }

    function test_transferToUnverifiedBlocked() public {
        uint256 pid = _registerProject(companyA);
        uint256 batch = _issue(pid, 5000, keccak256("S1"));
        vm.prank(companyA);
        vm.expectRevert();
        credit.safeTransferFrom(companyA, stranger, batch, 100, "");
    }
}
