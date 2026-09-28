// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Ledger} from "../src/ledger/Ledger.sol";
import {MerkleSumTree} from "../src/ledger/MerkleSumTree.sol";
import {LedgerTWD} from "../src/ledger/LedgerTWD.sol";

/// 帳本合約的測試，大部分以 TypeScript 產生的 fixture（test/fixtures/ledger.json）為輸入：
/// 同一份情境在 web/scripts/lib/ledger-scenario.mjs 重播、建樹、出證據，這裡驗合約接不接受。
/// fixture 過期時執行 `cd web && npm run gen:ledger-fixture`。
contract LedgerTest is Test {
    using stdJson for string;

    Ledger internal ledger;
    LedgerTWD internal twd;
    string internal fx;
    address internal sovereign = makeAddr("sovereign");
    address internal operator = makeAddr("operator");
    address internal committer = makeAddr("committer");
    address internal admin = makeAddr("admin");
    address internal account;

    function setUp() public {
        fx = vm.readFile("test/fixtures/ledger.json");
        ledger = new Ledger(admin, sovereign, operator);
        twd = ledger.cash();
        bytes32 committerRole = ledger.COMMITTER_ROLE();
        vm.prank(operator);
        ledger.grantRole(committerRole, committer);
        account = fx.readAddress(".claim.account");
        // 鏈上的 TWD 要有帳本宣稱的那麼多，否則承諾會被 Insolvent 擋下
        vm.prank(operator);
        ledger.creditDeposit(account, fx.readUint(".epochs[1].totalCash"), keccak256("bank:setup"));
        vm.roll(1_000);
    }

    function _input(uint256 i) internal view returns (Ledger.CommitInput memory c) {
        string memory k = string.concat(".epochs[", vm.toString(i), "]");
        c.prev = fx.readBytes32(string.concat(k, ".prev"));
        c.epoch = uint64(fx.readUint(string.concat(k, ".epoch")));
        c.logRoot = fx.readBytes32(string.concat(k, ".logRoot"));
        c.balanceRoot = fx.readBytes32(string.concat(k, ".balanceRoot"));
        c.registryRoot = fx.readBytes32(string.concat(k, ".registryRoot"));
        c.identityRoot = fx.readBytes32(string.concat(k, ".identityRoot"));
        c.totalKg = fx.readUint(string.concat(k, ".totalKg"));
        c.totalCash = fx.readUint(string.concat(k, ".totalCash"));
        c.totalsHash = fx.readBytes32(string.concat(k, ".totalsHash"));
        c.upToBlock = uint64(fx.readUint(string.concat(k, ".upToBlock")));
        c.lastSeq = uint64(fx.readUint(string.concat(k, ".lastSeq")));
        c.rulesVersion = uint16(fx.readUint(string.concat(k, ".rulesVersion")));
    }

    function _commitBoth() internal {
        vm.startPrank(committer);
        ledger.commit(_input(0));
        ledger.commit(_input(1));
        vm.stopPrank();
    }

    function _balanceProof() internal view returns (Ledger.BalanceProof memory p) {
        p.proofEpoch = uint64(fx.readUint(".claim.proofEpoch"));
        p.assetsRoot = fx.readBytes32(".claim.assetsRoot");
        p.leafKg = fx.readUint(".claim.leafKg");
        p.leafCash = fx.readUint(".claim.leafCash");
        p.leafRequested = fx.readUint(".claim.leafRequested");
        p.leafSettled = fx.readUint(".claim.leafSettled");
        bytes32[] memory h = fx.readBytes32Array(".claim.siblingHashes");
        uint256[] memory kg = fx.readUintArray(".claim.siblingKgs");
        uint256[] memory cash = fx.readUintArray(".claim.siblingCashes");
        p.siblings = new MerkleSumTree.Node[](h.length);
        for (uint256 i = 0; i < h.length; i++) p.siblings[i] = MerkleSumTree.Node(h[i], kg[i], cash[i]);
        p.path = fx.readUint(".claim.path");
    }

    // ── 跨語言一致性 ──

    function test_anchorMatchesTypeScript() public view {
        assertEq(ledger.anchorOf(_input(0)), fx.readBytes32(".epochs[0].anchor"), unicode"第 1 期 anchor 與 TypeScript 不同");
        assertEq(ledger.anchorOf(_input(1)), fx.readBytes32(".epochs[1].anchor"), unicode"第 2 期 anchor 與 TypeScript 不同");
    }

    function test_commitChain() public {
        _commitBoth();
        assertEq(ledger.epoch(), 2);
        assertEq(ledger.head(), fx.readBytes32(".epochs[1].anchor"));
        assertEq(ledger.commitmentOf(2).registryRoot, fx.readBytes32(".epochs[1].registryRoot"));
    }

    // ── 新台幣入金 ──

    function test_creditDepositMintsToLedgerOnly() public {
        uint256 before = twd.totalSupply();
        vm.expectEmit(true, true, false, true);
        emit Ledger.CashDeposited(account, 500e6, keccak256("bank:1"));
        vm.prank(operator);
        ledger.creditDeposit(account, 500e6, keccak256("bank:1"));
        assertEq(twd.totalSupply(), before + 500e6);
        assertEq(twd.balanceOf(address(ledger)), twd.totalSupply(), unicode"唯一的持有人是帳本合約");
        assertEq(twd.balanceOf(account), 0, unicode"使用者的錢包裡沒有任何 TWD");
    }

    function test_onlyOperatorCredits() public {
        vm.expectRevert();
        ledger.creditDeposit(account, 1e6, keccak256("bank:x"));
        vm.prank(committer);
        vm.expectRevert();
        ledger.creditDeposit(account, 1e6, keccak256("bank:x"));
    }

    function test_bankRefCannotBeReused() public {
        vm.startPrank(operator);
        ledger.creditDeposit(account, 1e6, keccak256("bank:dup"));
        vm.expectRevert(abi.encodeWithSelector(Ledger.BankRefUsed.selector, keccak256("bank:dup")));
        ledger.creditDeposit(account, 1e6, keccak256("bank:dup"));
        vm.expectRevert(abi.encodeWithSelector(Ledger.BankRefUsed.selector, bytes32(0)));
        ledger.creditDeposit(account, 1e6, bytes32(0));
        vm.stopPrank();
    }

    function test_twdIsNotTransferable() public {
        vm.prank(address(ledger));
        vm.expectRevert(LedgerTWD.NonTransferable.selector);
        twd.transfer(account, 1);
        vm.expectRevert(LedgerTWD.NotLedger.selector);
        twd.mint(1);
        vm.expectRevert(LedgerTWD.NotLedger.selector);
        twd.burn(1);
    }

    // ── 新台幣出金 ──

    function test_settleWithdrawalWithTypeScriptProof() public {
        _commitBoth();
        uint256 requested = fx.readUint(".claim.leafRequested");
        uint256 cashOwed = fx.readUint(".claim.leafCash");
        assertGt(requested, 0, "fixture should include a withdrawal request");
        uint256 supply = twd.totalSupply();
        // 帳本裡還在用的錢不能出金：上限是已經簽過請求的部分
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ledger.SumMismatch.selector, requested, cashOwed + requested));
        ledger.settleWithdrawal(account, cashOwed + requested, keccak256("bank:out1"), _balanceProof());
        vm.prank(operator);
        ledger.settleWithdrawal(account, requested, keccak256("bank:out1"), _balanceProof());
        assertEq(twd.totalSupply(), supply - requested, unicode"出金銷毀同額");
        assertEq(ledger.withdrawnTotal(account), requested);
        // 同一筆請求不能出金第二次
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ledger.NothingLeft.selector, account, uint64(2)));
        ledger.settleWithdrawal(account, 1, keccak256("bank:out2"), _balanceProof());
    }

    function test_settleInParts() public {
        _commitBoth();
        uint256 requested = fx.readUint(".claim.leafRequested");
        vm.startPrank(operator);
        ledger.settleWithdrawal(account, requested / 3, keccak256("bank:p1"), _balanceProof());
        ledger.settleWithdrawal(account, requested - requested / 3, keccak256("bank:p2"), _balanceProof());
        vm.stopPrank();
        assertEq(ledger.withdrawnTotal(account), requested);
    }

    function test_onlyOperatorSettles() public {
        _commitBoth();
        Ledger.BalanceProof memory p = _balanceProof();
        vm.prank(account);
        vm.expectRevert();
        ledger.settleWithdrawal(account, 1, keccak256("bank:u"), p);
        vm.prank(committer);
        vm.expectRevert();
        ledger.settleWithdrawal(account, 1, keccak256("bank:u"), p);
    }

    function test_settleRejectsSomeoneElsesProof() public {
        _commitBoth();
        vm.prank(operator);
        vm.expectRevert(Ledger.BadProof.selector);
        ledger.settleWithdrawal(makeAddr("other"), 1, keccak256("bank:o"), _balanceProof());
    }

    function test_oldEpochProofRejected() public {
        _commitBoth();
        Ledger.BalanceProof memory p = _balanceProof();
        p.proofEpoch = 1;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ledger.NotLatestEpoch.selector, uint64(2), uint64(1)));
        ledger.settleWithdrawal(account, 1, keccak256("bank:old"), p);
    }

    function test_noEscapeHatch() public {
        _commitBoth();
        vm.warp(block.timestamp + 365 days);
        // 停擺多久都一樣：鏈上沒有任何人領得走的東西，只有證據
        vm.prank(account);
        vm.expectRevert();
        ledger.settleWithdrawal(account, 1, keccak256("bank:e"), _balanceProof());
        (uint256 owed, uint256 held,,) = ledger.solvency();
        assertLe(owed, held);
    }

    // ── 承諾的檢查 ──

    function test_onlyCommitter() public {
        Ledger.CommitInput memory c = _input(0);
        vm.expectRevert();
        ledger.commit(c);
    }

    function test_chainMustLink() public {
        Ledger.CommitInput memory c = _input(1);
        vm.prank(committer);
        vm.expectRevert();
        ledger.commit(c); // 跳過第 1 期
    }

    function test_insolventCommitRejected() public {
        Ledger.CommitInput memory c = _input(0);
        c.totalCash = twd.balanceOf(address(ledger)) + 1;
        vm.prank(committer);
        vm.expectRevert();
        ledger.commit(c);
    }

    function test_upToBlockCannotBeFuture() public {
        Ledger.CommitInput memory c = _input(0);
        c.upToBlock = uint64(block.number + 1);
        vm.prank(committer);
        vm.expectRevert();
        ledger.commit(c);
    }

    // ── 授權金鑰清單 ──

    function test_authorityOnlyBySovereign() public {
        bytes32 role = ledger.AUTH_CARBON_VERIFIER();
        address v = makeAddr("verifier");
        vm.expectRevert();
        ledger.grantAuthority(role, v);

        vm.expectEmit(true, true, false, false);
        emit Ledger.AuthorityGranted(role, v);
        vm.prank(sovereign);
        ledger.grantAuthority(role, v);
        assertTrue(ledger.isAuthority(role, v));

        vm.prank(sovereign);
        ledger.revokeAuthority(role, v);
        assertFalse(ledger.isAuthority(role, v));
    }

    function test_committerCannotTouchAuthorities() public {
        bytes32 role = ledger.AUTH_IDENTITY_VERIFIER();
        vm.prank(committer);
        vm.expectRevert();
        ledger.grantAuthority(role, committer);
    }

    function test_thresholdOnlyBySovereignAndNonZero() public {
        bytes32 role = ledger.AUTH_SOVEREIGN();
        assertEq(ledger.thresholdOf(role), 0, "unset reads as 0 (treated as 1 off-chain)");
        vm.expectRevert();
        ledger.setThreshold(role, 2);
        vm.prank(committer);
        vm.expectRevert();
        ledger.setThreshold(role, 2);

        vm.expectEmit(true, false, false, true);
        emit Ledger.ThresholdSet(role, 2);
        vm.prank(sovereign);
        ledger.setThreshold(role, 2);
        assertEq(ledger.thresholdOf(role), 2);

        vm.prank(sovereign);
        vm.expectRevert(abi.encodeWithSelector(Ledger.BadThreshold.selector, uint8(0)));
        ledger.setThreshold(role, 0);
    }
}
