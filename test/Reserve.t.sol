// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReserveAttestation} from "../src/registry/ReserveAttestation.sol";

/// 託管與準備金的定期揭露。
///
/// 重點只有一個：**定稿之後不能改**。一份可以事後改寫的揭露，跟沒有揭露一樣。
contract ReserveTest is Test {
    ReserveAttestation internal reserve;
    address internal sovereign = makeAddr("sovereign");
    address internal operator = makeAddr("operator");
    address internal reporter = makeAddr("reporter");
    address internal auditor = makeAddr("auditor");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        reserve = new ReserveAttestation(sovereign, sovereign, operator);
        // 角色常數要先讀出來：vm.prank 只作用於下一個呼叫，
        // 寫成 grantRole(reserve.REPORTER_ROLE(), ...) 會讓那個 view 把 prank 吃掉。
        bytes32 reporterRole = reserve.REPORTER_ROLE();
        bytes32 auditorRole = reserve.AUDITOR_ROLE();
        vm.prank(operator);
        reserve.grantRole(reporterRole, reporter);
        vm.prank(sovereign);
        reserve.grantRole(auditorRole, auditor);
    }

    function _rows() internal pure returns (ReserveAttestation.CreditReserve[] memory c) {
        c = new ReserveAttestation.CreditReserve[](2);
        c[0] = ReserveAttestation.CreditReserve({
            country: "TW",
            custodian: unicode"環境部 溫室氣體減量額度管理系統",
            accountRef: "TW-ACC-0001",
            heldKg: 100_000,
            onchainKg: 100_000,
            statementHash: keccak256("tw")
        });
        c[1] = ReserveAttestation.CreditReserve({
            country: "JP",
            custodian: unicode"Ｊ－クレジット登録簿",
            accountRef: "JP-ACC-0007",
            heldKg: 40_000,
            onchainKg: 39_000, // 差異：鏈上少 1 噸
            statementHash: keccak256("jp")
        });
    }

    function _cash() internal pure returns (ReserveAttestation.CashReserve memory) {
        return ReserveAttestation.CashReserve({
            trustee: unicode"某某商業銀行 信託部",
            accountRef: "TRUST-001",
            balance: 1_000_000e6,
            tokenSupply: 1_000_000e6,
            statementHash: keccak256("cash")
        });
    }

    function _publish() internal returns (uint256) {
        vm.prank(reporter);
        return reserve.publish(202609, uint64(block.timestamp), _rows(), _cash());
    }

    function test_publishAndRead() public {
        uint256 id = _publish();
        (
            ReserveAttestation.Report memory r,
            ReserveAttestation.CreditReserve[] memory c,
            ReserveAttestation.CashReserve memory cash
        ) = reserve.reportOf(id);
        assertEq(r.period, 202609);
        assertEq(uint8(r.status), uint8(ReserveAttestation.Status.Draft));
        assertEq(c.length, 2);
        assertEq(c[1].country, bytes2("JP"));
        assertEq(cash.balance, 1_000_000e6);
        assertEq(reserve.reportOfPeriod(202609), id);
        assertEq(reserve.periods().length, 1);
    }

    function test_onlyReporterCanPublish() public {
        vm.prank(stranger);
        vm.expectRevert();
        reserve.publish(202609, uint64(block.timestamp), _rows(), _cash());
        // 連營運角色本身都不行：發布用的是可撤銷的服務金鑰，不是治理角色
        vm.prank(operator);
        vm.expectRevert();
        reserve.publish(202609, uint64(block.timestamp), _rows(), _cash());
    }

    function test_auditorAttests() public {
        uint256 id = _publish();
        vm.prank(auditor);
        reserve.attest(id, ReserveAttestation.Status.Discrepancy, unicode"某某會計師事務所", unicode"日本帳戶多 1 公噸待沖銷");
        (ReserveAttestation.Report memory r,,) = reserve.reportOf(id);
        assertEq(uint8(r.status), uint8(ReserveAttestation.Status.Discrepancy));
        assertEq(r.auditor, auditor);
        assertTrue(r.attestedAt > 0);
    }

    function test_cannotAttestTwice() public {
        uint256 id = _publish();
        vm.prank(auditor);
        reserve.attest(id, ReserveAttestation.Status.Attested, "A", "");
        vm.prank(auditor);
        vm.expectRevert(abi.encodeWithSelector(ReserveAttestation.AlreadyAttested.selector, id));
        reserve.attest(id, ReserveAttestation.Status.Attested, "A", unicode"想改一下");
    }

    function test_reporterCannotAttest() public {
        uint256 id = _publish();
        vm.prank(reporter);
        vm.expectRevert();
        reserve.attest(id, ReserveAttestation.Status.Attested, "self", "");
    }

    function test_emptyReportRejected() public {
        ReserveAttestation.CreditReserve[] memory none = new ReserveAttestation.CreditReserve[](0);
        vm.prank(reporter);
        vm.expectRevert(ReserveAttestation.EmptyReport.selector);
        reserve.publish(202609, uint64(block.timestamp), none, _cash());
    }

    /// 更正只能發新的一份；舊的那份還在，任何人都查得到。
    function test_correctionKeepsOldReport() public {
        uint256 first = _publish();
        vm.prank(auditor);
        reserve.attest(first, ReserveAttestation.Status.Discrepancy, "A", unicode"有差異");
        uint256 second = _publish();
        assertEq(reserve.reportOfPeriod(202609), second);
        (ReserveAttestation.Report memory old,,) = reserve.reportOf(first);
        assertEq(uint8(old.status), uint8(ReserveAttestation.Status.Discrepancy));
        assertEq(reserve.periods().length, 1);
    }

    function test_documentHash() public {
        uint256 id = _publish();
        vm.prank(reporter);
        reserve.setDocumentHash(id, keccak256("pdf"));
        (ReserveAttestation.Report memory r,,) = reserve.reportOf(id);
        assertEq(r.documentHash, keccak256("pdf"));
    }

    function test_unknownReport() public {
        vm.expectRevert(abi.encodeWithSelector(ReserveAttestation.UnknownReport.selector, uint256(99)));
        reserve.reportOf(99);
    }
}
