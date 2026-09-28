// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Ledger} from "../src/ledger/Ledger.sol";
import {MerkleSumTree} from "../src/bank/MerkleSumTree.sol";
import {MockTWD} from "../src/mocks/MockTWD.sol";

/// 帳本合約的測試，大部分以 TypeScript 產生的 fixture（test/fixtures/ledger.json）為輸入：
/// 同一份情境在 web/scripts/lib/ledger-scenario.mjs 重播、建樹、出證據，這裡驗合約接不接受。
/// fixture 過期時執行 `cd web && npm run gen:ledger-fixture`。
contract LedgerTest is Test {
    using stdJson for string;

    Ledger internal ledger;
    MockTWD internal twd;
    string internal fx;
    address internal sovereign = makeAddr("sovereign");
    address internal operator = makeAddr("operator");
    address internal committer = makeAddr("committer");
    address internal admin = makeAddr("admin");
    address internal account;

    function setUp() public {
        fx = vm.readFile("test/fixtures/ledger.json");
        twd = new MockTWD(address(this));
        ledger = new Ledger(address(twd), admin, sovereign, operator);
        bytes32 committerRole = ledger.COMMITTER_ROLE();
        vm.prank(operator);
        ledger.grantRole(committerRole, committer);
        account = fx.readAddress(".claim.account");
        // 池子裡要有帳本宣稱的那麼多結算幣，否則承諾會被 Insolvent 擋下
        twd.mint(address(this), 10_000_000e6);
        twd.approve(address(ledger), type(uint256).max);
        ledger.depositCash(fx.readUint(".epochs[1].totalCash"));
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

    function _creditProof() internal view returns (Ledger.CreditProof memory cp) {
        cp.batchKg = fx.readUint(".claim.batchKg");
        cp.assetSiblings = fx.readBytes32Array(".claim.assetSiblings");
        cp.assetPath = fx.readUint(".claim.assetPath");
        cp.batch = Ledger.BatchLeaf({
            id: fx.readUint(".claim.batch.id"),
            projectId: fx.readUint(".claim.batch.projectId"),
            monitoringStart: uint64(fx.readUint(".claim.batch.monitoringStart")),
            monitoringEnd: uint64(fx.readUint(".claim.batch.monitoringEnd")),
            vintageYear: uint16(fx.readUint(".claim.batch.vintageYear")),
            serialHash: fx.readBytes32(".claim.batch.serialHash"),
            reportHash: fx.readBytes32(".claim.batch.reportHash"),
            verifier: fx.readAddress(".claim.batch.verifier"),
            issuedAt: uint64(fx.readUint(".claim.batch.issuedAt")),
            issuedKg: fx.readUint(".claim.batch.issuedKg"),
            retiredKg: fx.readUint(".claim.batch.retiredKg"),
            frozen: fx.readBool(".claim.batch.frozen")
        });
        cp.registrySiblings = fx.readBytes32Array(".claim.registrySiblings");
        cp.registryPath = fx.readUint(".claim.registryPath");
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

    function test_claimCreditsWithTypeScriptProof() public {
        _commitBoth();
        vm.prank(operator);
        ledger.setWithdrawalsEnabled(true);
        uint256 kg = fx.readUint(".claim.batchKg");
        vm.expectEmit(true, true, false, false);
        emit Ledger.CreditClaimed(account, 1, kg, 2, 0, 0, bytes32(0));
        vm.prank(account);
        ledger.claimCredits(kg, _balanceProof(), _creditProof());
        assertEq(ledger.claimedKg(account, 2, 1), kg);

        // 同一份證據不能超過持有量
        vm.prank(account);
        vm.expectRevert();
        ledger.claimCredits(1, _balanceProof(), _creditProof());
    }

    function test_claimRejectsTamperedBatch() public {
        _commitBoth();
        vm.prank(operator);
        ledger.setWithdrawalsEnabled(true);
        Ledger.CreditProof memory cp = _creditProof();
        cp.batch.issuedKg += 1; // 宣稱多核發一公斤
        vm.prank(account);
        vm.expectRevert(Ledger.BadProof.selector);
        ledger.claimCredits(1, _balanceProof(), cp);
    }

    function test_claimRejectsSomeoneElse() public {
        _commitBoth();
        vm.prank(operator);
        ledger.setWithdrawalsEnabled(true);
        Ledger.BalanceProof memory p = _balanceProof();
        Ledger.CreditProof memory cp = _creditProof();
        vm.prank(makeAddr("thief"));
        vm.expectRevert(Ledger.BadProof.selector);
        ledger.claimCredits(1, p, cp);
    }

    function test_withdrawCashWithTypeScriptProof() public {
        _commitBoth();
        vm.prank(operator);
        ledger.setWithdrawalsEnabled(true);
        uint256 requested = fx.readUint(".claim.leafRequested");
        uint256 cashOwed = fx.readUint(".claim.leafCash");
        assertGt(requested, 0);
        assertGt(cashOwed, requested);
        // 一般提領只能領**已請求**的部分：帳本裡還能交易的錢不能同時被領走
        vm.prank(account);
        vm.expectRevert(abi.encodeWithSelector(Ledger.SumMismatch.selector, requested, cashOwed));
        ledger.withdrawCash(cashOwed, _balanceProof());
        vm.prank(account);
        ledger.withdrawCash(requested, _balanceProof());
        assertEq(twd.balanceOf(account), requested);
        assertEq(ledger.withdrawnTotal(account), requested);
        // 累計：同一份證據（或下一期還沒銷帳的證據）不能再領第二次
        vm.prank(account);
        vm.expectRevert(abi.encodeWithSelector(Ledger.NothingLeft.selector, account, uint64(2)));
        ledger.withdrawCash(1, _balanceProof());
    }

    function test_withdrawInParts() public {
        _commitBoth();
        vm.prank(operator);
        ledger.setWithdrawalsEnabled(true);
        uint256 requested = fx.readUint(".claim.leafRequested");
        vm.startPrank(account);
        ledger.withdrawCash(requested / 3, _balanceProof());
        ledger.withdrawCash(requested - requested / 3, _balanceProof());
        vm.stopPrank();
        assertEq(twd.balanceOf(account), requested);
    }

    // ── 逃生門 ──

    function test_escapeOpensAfter72HoursWithoutCommit() public {
        _commitBoth();
        uint256 owed = fx.readUint(".claim.leafCash");
        vm.prank(account);
        vm.expectRevert(Ledger.WithdrawalsDisabled.selector);
        ledger.withdrawCash(owed, _balanceProof());

        vm.warp(block.timestamp + 72 hours + 1);
        assertTrue(ledger.escapeActive());
        // 逃生：帳本凍結了，可以領全部欠款（葉子的現金＋已領累計，減掉已經領走的）
        owed += fx.readUint(".claim.leafSettled");
        vm.prank(account);
        ledger.withdrawCash(owed, _balanceProof());
        assertEq(twd.balanceOf(account), owed);
        vm.prank(account);
        ledger.claimCredits(1, _balanceProof(), _creditProof());
    }

    function test_operatorCannotCloseEscape() public {
        _commitBoth();
        vm.warp(block.timestamp + 72 hours + 1);
        vm.prank(operator);
        ledger.setWithdrawalsEnabled(false);
        assertTrue(ledger.escapeActive());
        vm.prank(account);
        ledger.withdrawCash(1, _balanceProof());
    }

    function test_oldEpochProofRejected() public {
        vm.prank(committer);
        ledger.commit(_input(0));
        vm.prank(operator);
        ledger.setWithdrawalsEnabled(true);
        vm.prank(committer);
        ledger.commit(_input(1));
        Ledger.BalanceProof memory p = _balanceProof();
        p.proofEpoch = 1;
        vm.prank(account);
        vm.expectRevert(abi.encodeWithSelector(Ledger.NotLatestEpoch.selector, uint64(2), uint64(1)));
        ledger.withdrawCash(1, p);
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
