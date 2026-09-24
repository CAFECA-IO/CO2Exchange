// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {Bank} from "../src/bank/Bank.sol";
import {MerkleSumTree} from "../src/bank/MerkleSumTree.sol";
import {CarbonCredit1155} from "../src/registry/CarbonCredit1155.sol";
import {RetirementCertificate} from "../src/registry/RetirementCertificate.sol";
import {IKYCRegistry} from "../src/interfaces/IKYCRegistry.sol";

/// Bank 池：使用者在交易所期間，資產放在這裡，內部買賣是帳本更新。
///
/// 這支測試守的是那個架構**沒有帶走**的東西：
///   · 承諾一旦提交就改不掉，而且串得起來
///   · 宣稱的負債不能超過實際持有（合約唯一驗得了的償付能力條件）
///   · 註銷仍然記名——憑證發給真正的受益人，不是發給 Bank
///   · 提領靠 Merkle 證據，不是靠交易所點頭；而且舊證據不能重放
contract BankTest is Fixture {
    Bank internal bank;
    uint256 internal batchA;
    uint256 internal batchB;

    address internal committer = makeAddr("committer");

    function setUp() public override {
        super.setUp();
        bank = new Bank(address(credit), address(twd), sovereign, operator);
        // 角色先取出來再 prank：`vm.prank(x); c.f(c.VIEW())` 的話，那個 view 呼叫
        // 會先被求值並**把 prank 用掉**，真正的 f() 就以測試合約的身分送出去了。
        bytes32 committerRole = bank.COMMITTER_ROLE();
        vm.prank(operator);
        bank.grantRole(committerRole, committer);

        // Bank 自己要能被身分層接受，否則存入的那一筆 transfer 會被 _update 擋下來。
        // 這是刻意的：邊界仍然守在鏈上，Bank 不是規則的例外。
        _registerIdentity(address(bank), IKYCRegistry.Tier.Corporate, keccak256("TW-BANK"));

        uint256 projectId = _registerProject(companyB);
        vm.startPrank(companyB);
        batchA = _issue(projectId, 100_000, keccak256("serial-A"));
        batchB = _issue(projectId, 50_000, keccak256("serial-B"));
        vm.stopPrank();
    }

    // ───────────────────────── 存入 ─────────────────────────

    function test_deposit_movesCreditsAndTracksTotal() public {
        vm.startPrank(companyB);
        credit.setApprovalForAll(address(bank), true);
        bank.deposit(batchA, 30_000);
        bank.deposit(batchB, 5_000);
        vm.stopPrank();

        assertEq(credit.balanceOf(address(bank), batchA), 30_000);
        assertEq(bank.totalHeldKg(), 35_000, unicode"跨批次的總持有量要自己記——1155 查不到這個數");
    }

    /// 身分規則沒有因為 Bank 而放寬：未驗證的帳戶存不進來。
    function test_deposit_stillGoesThroughKycBoundary() public {
        address stranger = makeAddr("stranger");
        vm.prank(companyB);
        credit.safeTransferFrom(companyB, alice, batchA, 1_000, "");

        vm.prank(sovereign);
        kyc.setFrozen(alice, true);

        vm.startPrank(alice);
        credit.setApprovalForAll(address(bank), true);
        vm.expectRevert();
        bank.deposit(batchA, 100);
        vm.stopPrank();
        stranger; // 未使用，留著說明意圖
    }

    // ───────────────────────── 承諾 ─────────────────────────

    function test_commit_chainsAndRejectsBrokenLink() public {
        _fund(companyB, batchA, 10_000);

        bytes32 a1 = _commit(bytes32(0), 1, bytes32("root1"), 10_000, 0);
        assertEq(bank.head(), a1);
        assertEq(bank.epoch(), 1);

        // 接在錯的地方要被擋下來。這一條就是「串連」。
        vm.prank(committer);
        vm.expectRevert(abi.encodeWithSelector(Bank.ChainBroken.selector, a1, bytes32(0)));
        bank.commit(bytes32(0), 2, bytes32("root2"), bytes32("b2"), 0, 0, bytes32(0), uint64(block.number));

        bytes32 a2 = _commit(a1, 2, bytes32("root2"), 10_000, 0);
        assertTrue(a2 != a1);
        assertEq(bank.head(), a2);
    }

    function test_commit_rejectsEpochOutOfOrder() public {
        bytes32 a1 = _commit(bytes32(0), 1, bytes32("root1"), 0, 0);
        vm.prank(committer);
        vm.expectRevert(abi.encodeWithSelector(Bank.EpochOutOfOrder.selector, 2, 5));
        bank.commit(a1, 5, bytes32("root5"), bytes32("b5"), 0, 0, bytes32(0), uint64(block.number));
    }

    /// 宣稱欠的比池子裡有的多 → 擋下來。
    ///
    /// 這是合約唯一驗得了的償付能力條件（它沒有帳本，驗不了餘額算得對不對）。
    /// 它擋掉的是最糟的那種錯：帳本算出一個池子裡根本沒有的數字，
    /// 然後有人拿著完全正確的證據來提領卻領不到——那時才發現就太晚了。
    function test_commit_rejectsInsolventClaim() public {
        _fund(companyB, batchA, 1_000);
        vm.prank(committer);
        vm.expectRevert(abi.encodeWithSelector(Bank.Insolvent.selector, 1_001, 1_000));
        bank.commit(bytes32(0), 1, bytes32("r"), bytes32("b"), 1_001, 0, bytes32(0), uint64(block.number));
    }

    function test_commit_onlyCommitterRole() public {
        vm.prank(operator);
        vm.expectRevert();
        bank.commit(bytes32(0), 1, bytes32("r"), bytes32("b"), 0, 0, bytes32(0), uint64(block.number));
    }

    /// 每一期都要記「這棵樹算到哪一個區塊為止」，而且必須嚴格遞增。
    ///
    /// 少了這個欄位，「任何人都能重算同一棵樹」就是空話：重算的人不知道該讀到哪裡，
    /// 多讀或少讀一個區塊都會得到不同的 root，而他無法判斷是自己讀錯還是交易所報錯。
    function test_commit_upToBlockMustAdvanceAndNotBeInTheFuture() public {
        bytes32 a1 = _commit(bytes32(0), 1, bytes32("r1"), 0, 0);

        vm.prank(committer);
        vm.expectRevert(
            abi.encodeWithSelector(Bank.BadUpToBlock.selector, uint64(block.number + 10), block.number)
        );
        bank.commit(a1, 2, bytes32("o"), bytes32("r2"), 0, 0, bytes32(0), uint64(block.number + 10));

        // 倒退也不行——同一段區塊被算進兩期，那兩期的樹就沒有意義了
        vm.prank(committer);
        vm.expectRevert();
        bank.commit(a1, 2, bytes32("o"), bytes32("r2"), 0, 0, bytes32(0), uint64(block.number - 1));
    }

    // ───────────────────────── 註銷（記名） ─────────────────────────

    /// 這是 Bank 架構最重要的一條：綜合帳戶託管**不影響**註銷憑證的記名。
    ///
    /// 鏈上看不到個別持有人，但碳權在法律上真正要緊的動作是註銷——憑證要附在申報
    /// 文件上、要記載受益人與用途。憑證發給使用者，不是發給 Bank。
    function test_retireFor_certificateNamesTheRealBeneficiary() public {
        _fund(companyB, batchA, 10_000);

        vm.prank(operator);
        uint256 certId = bank.retireFor(
            companyB, batchA, 2_000, keccak256("beneficiary"), unicode"某某股份有限公司",
            RetirementCertificate.Purpose.CarbonFee, "2026 carbon fee"
        );

        assertEq(cert.ownerOf(certId), companyB, unicode"憑證必須在使用者名下，不是 Bank");
        assertEq(bank.totalHeldKg(), 8_000);
        assertEq(credit.balanceOf(address(bank), batchA), 8_000);
    }

    /// 用途 × 轄區的規則也還在鏈上——註銷不是繞過規則的後門。
    function test_retireFor_stillChecksPurposeRules() public {
        _fund(companyB, batchA, 1_000);
        vm.prank(alice);
        vm.expectRevert();
        bank.retireFor(companyB, batchA, 1, bytes32(0), "x", RetirementCertificate.Purpose.CarbonFee, "");
    }

    // ───────────────────────── 提領 ─────────────────────────

    function test_withdraw_disabledByDefault() public {
        _fund(companyB, batchA, 1_000);
        Bank.WithdrawProof memory p = _singleLeafProof(companyB, batchA, 1_000, 0, 1);
        _commitTree(bytes32(0), 1, companyB, batchA, 1_000, 0);

        vm.prank(companyB);
        vm.expectRevert(Bank.WithdrawalsDisabled.selector);
        bank.withdraw(batchA, 100, p);
    }

    /// 完整的提領路徑。**Phase 0 關著，但要是真的能用的**——
    /// 一個沒被跑過的提領路徑等於沒有提領路徑。
    function test_withdraw_withValidProof() public {
        _fund(companyB, batchA, 10_000);
        _commitTree(bytes32(0), 1, companyB, batchA, 10_000, 0);
        vm.prank(operator);
        bank.setWithdrawalsEnabled(true);

        uint256 before = credit.balanceOf(companyB, batchA);
        Bank.WithdrawProof memory p = _singleLeafProof(companyB, batchA, 10_000, 0, 1);
        vm.prank(companyB);
        bank.withdraw(batchA, 4_000, p);

        assertEq(credit.balanceOf(companyB, batchA), before + 4_000);
        assertEq(bank.totalHeldKg(), 6_000);
    }

    /// 同一份證據不能用兩次。葉子記的是**當期餘額**，用兩次就是領兩倍。
    function test_withdraw_sameEpochOnlyOnce() public {
        _fund(companyB, batchA, 10_000);
        _commitTree(bytes32(0), 1, companyB, batchA, 10_000, 0);
        vm.prank(operator);
        bank.setWithdrawalsEnabled(true);

        Bank.WithdrawProof memory p = _singleLeafProof(companyB, batchA, 10_000, 0, 1);
        vm.startPrank(companyB);
        bank.withdraw(batchA, 1_000, p);
        vm.expectRevert(abi.encodeWithSelector(Bank.AlreadyWithdrawnThisEpoch.selector, companyB, uint64(1)));
        bank.withdraw(batchA, 1_000, p);
        vm.stopPrank();
    }

    /// 舊 epoch 的證據不能用。舊 root 上的餘額可能已經在交易所裡花掉了——
    /// 「拿舊證據領走已經賣掉的東西」是這類設計最典型的漏洞。
    function test_withdraw_rejectsStaleEpoch() public {
        _fund(companyB, batchA, 10_000);
        bytes32 a1 = _commitTree(bytes32(0), 1, companyB, batchA, 10_000, 0);
        vm.prank(operator);
        bank.setWithdrawalsEnabled(true);

        Bank.WithdrawProof memory old = _singleLeafProof(companyB, batchA, 10_000, 0, 1);
        // 第二期：這個人在交易所裡把額度賣掉了，餘額歸零
        _commitTree(a1, 2, companyB, batchA, 0, 0);

        vm.prank(companyB);
        vm.expectRevert(abi.encodeWithSelector(Bank.NotLatestEpoch.selector, uint64(2), uint64(1)));
        bank.withdraw(batchA, 1_000, old);
    }

    /// 動過的證據驗不過。
    function test_withdraw_rejectsInflatedLeaf() public {
        _fund(companyB, batchA, 10_000);
        _commitTree(bytes32(0), 1, companyB, batchA, 10_000, 0);
        vm.prank(operator);
        bank.setWithdrawalsEnabled(true);

        Bank.WithdrawProof memory p = _singleLeafProof(companyB, batchA, 10_000, 0, 1);
        p.batchKg = 99_999; // 多報
        vm.prank(companyB);
        vm.expectRevert(Bank.BadProof.selector);
        bank.withdraw(batchA, 99_999, p);
    }

    /// 別人的證據領不走我的錢：葉子把 account 蓋進雜湊裡。
    function test_withdraw_cannotUseSomeoneElsesLeaf() public {
        _fund(companyB, batchA, 10_000);
        _commitTree(bytes32(0), 1, companyB, batchA, 10_000, 0);
        vm.prank(operator);
        bank.setWithdrawalsEnabled(true);

        Bank.WithdrawProof memory p = _singleLeafProof(companyB, batchA, 10_000, 0, 1);
        vm.prank(alice);
        vm.expectRevert(Bank.BadProof.selector);
        bank.withdraw(batchA, 1_000, p);
    }

    function test_solvency_reportsBothSides() public {
        _fund(companyB, batchA, 10_000);
        _commitTree(bytes32(0), 1, companyB, batchA, 8_000, 0);
        (uint256 owedKg, uint256 heldKg,,) = bank.solvency();
        assertEq(owedKg, 8_000);
        assertEq(heldKg, 10_000, unicode"多出來的 2,000 是還沒入帳的存入，揭露頁要看得到這個差");
    }

    // ───────────────────────── helpers ─────────────────────────

    function _fund(address who, uint256 batchId, uint256 kg) internal {
        vm.startPrank(who);
        credit.setApprovalForAll(address(bank), true);
        bank.deposit(batchId, kg);
        vm.stopPrank();
    }

    function _commit(bytes32 prev, uint64 ep, bytes32 balanceRoot, uint256 totalKg, uint256 totalCash)
        internal
        returns (bytes32)
    {
        // 每一期的 upToBlock 必須嚴格遞增，所以往前推一個區塊再提交
        vm.roll(block.number + 1);
        vm.prank(committer);
        return bank.commit(
            prev, ep, bytes32("orderlog"), balanceRoot, totalKg, totalCash, bytes32("totals"), uint64(block.number)
        );
    }

    /// 只有一個帳戶、一個批次的樹：root 就是葉子本身，證據是空的。
    /// 這是最小但完整的形狀——多葉子的樹由 BankTree.t.sol 對 TypeScript 驗證。
    function _commitTree(bytes32 prev, uint64 ep, address who, uint256 batchId, uint256 kg, uint256 cash)
        internal
        returns (bytes32)
    {
        bytes32 assetsRoot = MerkleSumTree.assetLeaf(batchId, kg);
        MerkleSumTree.Node memory leaf = MerkleSumTree.leaf(who, ep, assetsRoot, kg, cash);
        return _commit(prev, ep, leaf.hash, kg, cash);
    }

    function _singleLeafProof(address, uint256 batchId, uint256 kg, uint256 cash, uint64 ep)
        internal
        pure
        returns (Bank.WithdrawProof memory p)
    {
        p.proofEpoch = ep;
        p.assetsRoot = MerkleSumTree.assetLeaf(batchId, kg);
        p.leafKg = kg;
        p.leafCash = cash;
        p.siblings = new MerkleSumTree.Node[](0);
        p.path = 0;
        p.batchKg = kg;
        p.assetSiblings = new bytes32[](0);
        p.assetPath = 0;
    }
}
