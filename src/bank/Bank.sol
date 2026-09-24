// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CarbonCredit1155} from "../registry/CarbonCredit1155.sol";
import {RetirementCertificate} from "../registry/RetirementCertificate.sol";
import {MerkleSumTree} from "./MerkleSumTree.sol";

/// @title Bank
/// @notice 交易所的資產池：使用者在交易所期間，碳權與結算幣都放在這裡，
///         內部買賣是帳本更新，不上鏈；每個 epoch 把**餘額樹的 root** 提交上鏈。
///
/// ## 這個設計換到了什麼、付出了什麼
///
/// 換到的：內部成交零鏈上交易。掛單、改單、撤單、成交都不必等出塊、不必付 gas，
/// 而且委託單簿不公開（對法人是商業機密）。原本「每一筆成交一次鏈上移轉」的
/// 成本結構整個消失。
///
/// 付出的，要講清楚，因為它是法律性質的改變：**鏈上看不到個別持有人**。
/// 鏈上只看得到「Bank 持有 N 公斤」。使用者持有的是對交易所的請求權，
/// 不是登錄在自己名下的額度。這就是綜合帳戶（omnibus）託管。
///
/// 所以這份合約的每一個設計，都是在補回那個性質改變帶走的東西：
///
///   1. **餘額樹 root 上鏈**（`commit`）—— 讓「交易所說你有多少」變成一個
///      事後改不掉的承諾，而不是一句話。
///   2. **帶總額的樹**（`MerkleSumTree`）—— 讓外界算得出總負債，
///      並與這個合約鏈上真的持有多少對照。少一噸就看得出來。
///   3. **註銷仍然記名**（`retireFor`）—— 碳權最重要的法律動作是註銷與憑證。
///      Bank 用自己的持有去 burn，但憑證發給**真正的受益人**，
///      而且 `checkRetire` / `checkRetirePurpose` 照樣在鏈上驗。
///      碳費扣抵要的那張憑證不受這個架構影響。
///   4. **提領靠證據，不靠交易所點頭**（`withdraw`）—— 拿得出 Merkle 分支就領得走。
///
/// ## 目前不開放提領
///
/// Phase 0 的 TideBit-DeFi 不提供提領，但機制要在，而且**要是真的能用的**。
/// 所以 `withdraw` 完整實作、完整測試，只是被 `withdrawalsEnabled` 關著。
/// 一個沒被跑過的提領路徑，等於沒有提領路徑。
///
/// 另一半是**逃生模式**（見 `escapeActive`）：營運方超過 72 小時沒有提交承諾，
/// 使用者憑最後一個 root 就能領走，不需要任何人同意，也沒有任何角色關得掉。
/// 少了它，提領只是「營運方正常時可以提領」——而那正好是最不需要保障的時候。
contract Bank is AccessControl, ERC1155Holder {
    using SafeERC20 for IERC20;
    using MerkleSumTree for MerkleSumTree.Node;

    bytes32 public constant SOVEREIGN_ROLE = keccak256("SOVEREIGN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    /// @dev 提交 epoch 承諾的服務金鑰。與 OPERATOR 分開：提交是每天都要做的例行動作，
    ///      不該用治理 Safe 的鑰匙；而它能做的事也只有提交，關不掉提領、動不了資產。
    bytes32 public constant COMMITTER_ROLE = keccak256("COMMITTER_ROLE");

    CarbonCredit1155 public immutable credit;
    IERC20 public immutable cash;

    /// @notice 串連起來的承諾鏈。改任何一個 epoch，後面全部對不上。
    bytes32 public head;
    uint64 public epoch;

    /// @notice 每個 epoch 的餘額樹 root 與總額。提領要對照它。
    struct Commitment {
        bytes32 orderLogRoot; // 這個 epoch 的委託單與簽章（B 期才會有內容）
        bytes32 balanceRoot; // 餘額樹 root
        uint256 totalKg; // 餘額樹的總公斤數
        uint256 totalCash; // 餘額樹的總結算幣
        bytes32 totalsHash; // 逐批次明細表的 hash（公開檔）
        /// @dev 這棵樹是**算到哪一個區塊為止**的。
        ///
        ///      少了它，「任何人都能重算同一棵樹」就是一句空話：重算的人不知道
        ///      該讀到哪裡，多讀一個區塊、少讀一個區塊都會得到不同的 root，
        ///      而他無法判斷是自己讀錯還是交易所報錯。
        ///      這是整個 A 期可驗證性的邊界條件，所以它必須上鏈，不能只寫在檔案裡。
        uint64 upToBlock;
        /// @dev 這一期涵蓋到委託單 log 的第幾號事件為止（上一期的 lastSeq + 1 起算）。
        ///
        ///      和 `upToBlock` 同一個道理：少了它，重播的人不知道哪些事件屬於這一期，
        ///      而 `orderLogRoot` 就驗不了。兩個邊界——鏈上事件讀到哪、log 讀到哪——
        ///      都必須上鏈，「任何人都能重算」才不是空話。
        uint64 lastSeq;
        uint64 committedAt;
    }

    mapping(uint64 => Commitment) public commitments;

    /// @notice 對**某一期的證據**已經領走多少。key: 帳戶 → epoch → batchId。
    ///
    /// @dev 原本是「同一個 epoch 只能領一次」（`lastWithdrawEpoch`）。那個規則有兩個問題：
    ///      手上有三個批次的人一期只領得走一個；而逃生模式下 epoch 根本不會前進，
    ///      等於只有一次機會。
    ///
    ///      改成累計之後規則只剩一條，兩種模式共用：**你可以領到最新的 root 說你有的那麼多，
    ///      減掉你已經對同一個 root 領走的**。下一期的樹本來就會把已領的扣掉
    ///      （`Withdrawn` 事件會進帳本），所以上限跟著換 root 自動重算，不會重複計算。
    mapping(address => mapping(uint64 => mapping(uint256 => uint256))) public withdrawnKg;
    mapping(address => mapping(uint64 => uint256)) public withdrawnCash;

    /// @notice 逃生模式：超過這段時間沒有新的承諾上鏈，使用者不必等營運方點頭就能提領。
    ///
    /// @dev 72 小時 ＝ 3 個 epoch，和帳戶復原的等待期同一個數量級（刻意的：
    ///      兩者回答的是同一類問題——「多久沒有動靜才算出事」）。
    ///
    ///      **沒有任何角色關得掉它**，連主權角色也不行。這一點是設計的重心而不是疏漏：
    ///      資產池的法律性質是商業託管，沒有信託那種法定的破產隔離，
    ///      所以「拿得回來」這件事不能靠法律地位撐，只能靠一個誰都關不掉的機制撐。
    ///      一個營運方關得掉的逃生門，在最需要它的那一天剛好不存在。
    uint64 public constant ESCAPE_AFTER = 72 hours;

    /// @notice 這個合約實際持有多少（跨所有批次）。餘額樹的總額要對得上它。
    /// @dev 自己記而不是每次去掃 ERC-1155：1155 沒有「某地址的所有 id 總和」這種查詢，
    ///      而償付能力檢查必須是一個**任何人都算得出來**的數，不能要求對方先索引全鏈。
    uint256 public totalHeldKg;

    bool public withdrawalsEnabled;

    event Deposited(address indexed account, uint256 indexed batchId, uint256 amountKg);
    event CashDeposited(address indexed account, uint256 amount);
    event Committed(
        uint64 indexed epoch,
        bytes32 anchor,
        bytes32 orderLogRoot,
        bytes32 balanceRoot,
        uint256 totalKg,
        uint256 totalCash,
        bytes32 totalsHash,
        uint64 upToBlock,
        uint64 lastSeq
    );
    event Withdrawn(address indexed account, uint256 indexed batchId, uint256 amountKg, uint64 epoch);
    event CashWithdrawn(address indexed account, uint256 amount, uint64 epoch);
    event WithdrawalsToggled(bool enabled);
    /// @notice 逃生模式下領不滿的部分。
    ///
    /// @dev 「先到先得、不足由平台補足」這個決策，只有在領不到的人**拿得到一份
    ///      可證明的欠款紀錄**時才追得回來——否則義務存在，證據卻散落在各處。
    ///      所以池子不夠時不是 revert，而是能領多少領多少，剩下的記在鏈上。
    ///      這筆紀錄就是之後向平台請求補足的依據。
    event Shortfall(address indexed account, uint256 indexed batchId, uint256 owedKg, uint256 paidKg, uint64 epoch);
    event CashShortfall(address indexed account, uint256 owed, uint256 paid, uint64 epoch);
    event RetiredFor(address indexed account, uint256 indexed batchId, uint256 amountKg, uint256 certId);

    error ZeroAmount();
    error ChainBroken(bytes32 expected, bytes32 got);
    error EpochOutOfOrder(uint64 expected, uint64 got);
    error UnknownEpoch(uint64 epoch);
    error NotLatestEpoch(uint64 latest, uint64 got);
    error NothingLeftToWithdraw(address account, uint64 epoch);
    error BadProof();
    error SumMismatch(uint256 expected, uint256 got);
    error WithdrawalsDisabled();
    error Insolvent(uint256 owed, uint256 held);
    error BadUpToBlock(uint64 upToBlock, uint256 head);
    error BadLastSeq(uint64 given, uint64 previous);

    constructor(address credit_, address cash_, address sovereign, address operator) {
        credit = CarbonCredit1155(credit_);
        cash = IERC20(cash_);
        _grantRole(DEFAULT_ADMIN_ROLE, sovereign);
        _grantRole(SOVEREIGN_ROLE, sovereign);
        _grantRole(OPERATOR_ROLE, operator);
        _setRoleAdmin(COMMITTER_ROLE, OPERATOR_ROLE);
    }

    // ───────────────────────── 存入 ─────────────────────────

    /// @notice 把碳權存進交易所。這一筆是鏈上移轉，之後的買賣都不是。
    /// @dev 身分與轄區規則由 `CarbonCredit1155._update` 在這一步檢查——
    ///      邊界仍然守在鏈上，內部帳本才是鏈下的。
    function deposit(uint256 batchId, uint256 amountKg) external {
        if (amountKg == 0) revert ZeroAmount();
        credit.safeTransferFrom(msg.sender, address(this), batchId, amountKg, "");
        totalHeldKg += amountKg;
        emit Deposited(msg.sender, batchId, amountKg);
    }

    function depositCash(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        cash.safeTransferFrom(msg.sender, address(this), amount);
        emit CashDeposited(msg.sender, amount);
    }

    // ───────────────────────── 承諾 ─────────────────────────

    /// @notice 提交這個 epoch 的承諾。
    ///
    /// @param prev 呼叫端算出來的上一個 anchor。對不上就 revert——這一行就是「串連」。
    ///        要求呼叫端帶著它，而不是合約自己讀 `head`，是為了讓**併發或重送**
    ///        不會安靜地接在錯的地方：提交者以為接在 k，實際接在 k+1，兩邊都不會報錯。
    ///
    /// @dev 這裡**不驗證** balanceRoot 算得對不對——合約做不到那件事，
    ///      它沒有帳本。驗證的方式是重播：主管機關與查核機構拿委託單 log 重跑撮合，
    ///      算出來的樹 root 必須等於這裡提交的。合約負責的是「提交過就改不掉」。
    function commit(
        bytes32 prev,
        uint64 newEpoch,
        bytes32 orderLogRoot,
        bytes32 balanceRoot,
        uint256 totalKg,
        uint256 totalCash,
        bytes32 totalsHash,
        uint64 upToBlock,
        uint64 lastSeq
    ) external onlyRole(COMMITTER_ROLE) returns (bytes32 anchor) {
        if (prev != head) revert ChainBroken(head, prev);
        if (newEpoch != epoch + 1) revert EpochOutOfOrder(epoch + 1, newEpoch);

        // 宣稱的負債不能超過實際持有。這是合約唯一驗得了的償付能力條件，
        // 而它擋掉的是最糟的那種錯：帳本算出一個池子裡根本沒有的數字，
        // 然後有人拿著正確的證據來提領，卻領不到——那時才發現就太晚了。
        if (totalKg > totalHeldKg) revert Insolvent(totalKg, totalHeldKg);
        uint256 heldCash = cash.balanceOf(address(this));
        if (totalCash > heldCash) revert Insolvent(totalCash, heldCash);

        if (upToBlock > block.number || upToBlock <= commitments[epoch].upToBlock) {
            revert BadUpToBlock(upToBlock, block.number);
        }
        // log 的序號只能往前。倒退等於把同一批事件算進兩期，那兩期的 root 都沒有意義。
        if (lastSeq < commitments[epoch].lastSeq) revert BadLastSeq(lastSeq, commitments[epoch].lastSeq);
        anchor = keccak256(
            abi.encode(prev, newEpoch, orderLogRoot, balanceRoot, totalKg, totalCash, totalsHash, upToBlock, lastSeq)
        );
        head = anchor;
        epoch = newEpoch;
        commitments[newEpoch] = Commitment({
            orderLogRoot: orderLogRoot,
            balanceRoot: balanceRoot,
            totalKg: totalKg,
            totalCash: totalCash,
            totalsHash: totalsHash,
            upToBlock: upToBlock,
            lastSeq: lastSeq,
            committedAt: uint64(block.timestamp)
        });
        emit Committed(newEpoch, anchor, orderLogRoot, balanceRoot, totalKg, totalCash, totalsHash, upToBlock, lastSeq);
    }

    // ───────────────────────── 註銷（記名） ─────────────────────────

    /// @notice 代帳戶註銷。額度從 Bank 的持有裡 burn，**憑證發給真正的受益人**。
    ///
    /// @dev 這是整個 Bank 架構裡最重要的一個函式。碳權在法律上真正要緊的動作是註銷——
    ///      憑證要附在申報文件上、要記載受益人、要記載用途與核發國。
    ///      `CarbonCredit1155.retire()` 的 `holder` 與 `certificateTo` 本來就是分開的參數，
    ///      所以綜合帳戶託管不影響這件事：持有人是 Bank，受益人是使用者，
    ///      而 `checkRetire(certificateTo)` 與 `checkRetirePurpose()` 照常在鏈上把關。
    ///
    ///      呼叫者是 OPERATOR——但它做的事由帳本決定，而帳本每個 epoch 上鏈。
    ///      註銷掉一個帳戶沒有的額度，下一次 commit 的餘額樹就對不上了。
    function retireFor(
        address account,
        uint256 batchId,
        uint256 amountKg,
        bytes32 beneficiaryHash,
        string calldata beneficiary,
        RetirementCertificate.Purpose purpose,
        string calldata memo
    ) external onlyRole(OPERATOR_ROLE) returns (uint256 certId) {
        if (amountKg == 0) revert ZeroAmount();
        certId = credit.retire(
            CarbonCredit1155.RetireRequest({
                holder: address(this),
                batchId: batchId,
                amountKg: amountKg,
                certificateTo: account,
                beneficiaryHash: beneficiaryHash,
                beneficiary: beneficiary,
                purpose: purpose,
                memo: memo
            })
        );
        totalHeldKg -= amountKg;
        emit RetiredFor(account, batchId, amountKg, certId);
    }

    // ───────────────────────── 逃生模式 ─────────────────────────

    /// @notice 營運方已經停擺多久沒有提交承諾？超過 `ESCAPE_AFTER` 就進逃生模式。
    ///
    /// @dev 純粹看時間，不看任何開關——這正是它的價值。判斷依據是**最後一期的提交時間**：
    ///      營運方只要還在正常運作（每 24 小時提交一次），這個值永遠是 false。
    ///
    ///      還沒有任何一期承諾時回 false：那時候沒有 root，也就沒有東西可以憑據提領。
    ///      剛部署完的合約不應該一開始就是逃生狀態。
    function escapeActive() public view returns (bool) {
        Commitment memory c = commitments[epoch];
        if (c.committedAt == 0) return false;
        return block.timestamp > uint256(c.committedAt) + ESCAPE_AFTER;
    }

    /// @notice 距離逃生模式開啟還有多久（秒）。0 = 已經開啟。給揭露頁用。
    function escapeIn() external view returns (uint256) {
        Commitment memory c = commitments[epoch];
        if (c.committedAt == 0) return type(uint256).max;
        uint256 at = uint256(c.committedAt) + ESCAPE_AFTER;
        return block.timestamp >= at ? 0 : at - block.timestamp;
    }

    // ───────────────────────── 提領 ─────────────────────────

    /// @notice 提領的證據。兩段路徑：帳戶在餘額樹裡、批次在該帳戶的資產小樹裡。
    struct WithdrawProof {
        uint64 proofEpoch;
        bytes32 assetsRoot;
        uint256 leafKg; // 這個帳戶跨所有批次的總公斤數（餘額樹葉子上的數字）
        uint256 leafCash;
        MerkleSumTree.Node[] siblings; // 餘額樹的兄弟節點
        uint256 path; // 位元圖：1 = 這一層兄弟在左邊
        uint256 batchKg; // 這個批次的公斤數（資產小樹的葉子）
        bytes32[] assetSiblings;
        uint256 assetPath;
    }

    /// @notice 憑證據提領某一個批次的額度。
    ///
    /// @dev 上限是「最新的 root 說你有多少，減掉你已經對同一個 root 領走的」。
    ///      下一期的樹會把已領的扣掉（`Withdrawn` 事件會進帳本），所以換了 root
    ///      上限自動重算，不會重複計算。
    ///
    ///      **逃生模式下池子不夠時不 revert，能領多少領多少，剩下的記成欠款。**
    ///      這是「先到先得、不足由平台補足」那個決策的實作：先到先得會讓後到的人
    ///      領不滿，而如果那時候只是交易失敗，後到的人手上什麼都沒有——
    ///      義務存在，證據卻不存在。所以差額要留在鏈上，成為請求補足的依據。
    ///
    ///      正常模式不做部分給付：`commit()` 已經擋掉了「宣稱的比持有的多」，
    ///      所以正常模式下池子不夠一定是別的地方出了錯，那時候應該大聲失敗。
    function withdraw(uint256 batchId, uint256 amountKg, WithdrawProof calldata p) external {
        bool escape = escapeActive();
        if (!withdrawalsEnabled && !escape) revert WithdrawalsDisabled();
        if (amountKg == 0) revert ZeroAmount();
        _checkProof(msg.sender, p);
        _verifyAsset(batchId, p);

        uint256 already = withdrawnKg[msg.sender][p.proofEpoch][batchId];
        if (already >= p.batchKg) revert NothingLeftToWithdraw(msg.sender, p.proofEpoch);
        uint256 owed = p.batchKg - already;
        if (amountKg > owed) revert SumMismatch(owed, amountKg);

        uint256 pay = amountKg;
        if (escape) {
            uint256 available = credit.balanceOf(address(this), batchId);
            if (available < pay) {
                emit Shortfall(msg.sender, batchId, amountKg, available, p.proofEpoch);
                pay = available;
            }
        }
        if (pay == 0) revert NothingLeftToWithdraw(msg.sender, p.proofEpoch);

        withdrawnKg[msg.sender][p.proofEpoch][batchId] = already + pay;
        totalHeldKg -= pay;
        credit.safeTransferFrom(address(this), msg.sender, batchId, pay, "");
        emit Withdrawn(msg.sender, batchId, pay, p.proofEpoch);
    }

    function withdrawCash(uint256 amount, WithdrawProof calldata p) external {
        bool escape = escapeActive();
        if (!withdrawalsEnabled && !escape) revert WithdrawalsDisabled();
        if (amount == 0) revert ZeroAmount();
        _checkProof(msg.sender, p);

        uint256 already = withdrawnCash[msg.sender][p.proofEpoch];
        if (already >= p.leafCash) revert NothingLeftToWithdraw(msg.sender, p.proofEpoch);
        uint256 owed = p.leafCash - already;
        if (amount > owed) revert SumMismatch(owed, amount);

        uint256 pay = amount;
        if (escape) {
            uint256 available = cash.balanceOf(address(this));
            if (available < pay) {
                emit CashShortfall(msg.sender, amount, available, p.proofEpoch);
                pay = available;
            }
        }
        if (pay == 0) revert NothingLeftToWithdraw(msg.sender, p.proofEpoch);

        withdrawnCash[msg.sender][p.proofEpoch] = already + pay;
        cash.safeTransfer(msg.sender, pay);
        emit CashWithdrawn(msg.sender, pay, p.proofEpoch);
    }

    /// @dev 驗證帳戶那片葉子確實在**最新** epoch 的餘額樹裡。
    ///
    ///      只接受最新的一個，不接受任何舊的：舊 root 上的餘額可能已經花掉了。
    ///      「拿舊證據領走已經賣掉的東西」是這類設計最典型的漏洞。
    function _checkProof(address account, WithdrawProof calldata p) internal view {
        if (p.proofEpoch != epoch) revert NotLatestEpoch(epoch, p.proofEpoch);
        Commitment memory c = commitments[p.proofEpoch];
        if (c.balanceRoot == bytes32(0)) revert UnknownEpoch(p.proofEpoch);

        MerkleSumTree.Node memory node =
            MerkleSumTree.leaf(account, p.proofEpoch, p.assetsRoot, p.leafKg, p.leafCash);
        MerkleSumTree.Node memory root = MerkleSumTree.computeRoot(node, p.siblings, p.path);
        if (root.hash != c.balanceRoot) revert BadProof();
        // 總額也要對上。只比雜湊的話，樹上的總額就沒有被這條路徑檢查到，
        // 而總額正是償付能力那一半的依據。
        if (root.kg != c.totalKg) revert SumMismatch(c.totalKg, root.kg);
        if (root.cash != c.totalCash) revert SumMismatch(c.totalCash, root.cash);
    }

    function _verifyAsset(uint256 batchId, WithdrawProof calldata p) internal pure {
        bytes32 assetLeaf = MerkleSumTree.assetLeaf(batchId, p.batchKg);
        bytes32 computed = MerkleSumTree.computeAssetRoot(assetLeaf, p.assetSiblings, p.assetPath);
        if (computed != p.assetsRoot) revert BadProof();
    }

    // ───────────────────────── 開關 ─────────────────────────

    /// @dev 提領的開關在營運角色手上（Phase 0 關著）。
    ///
    ///      逃生模式**不受這個開關影響**，而且沒有任何角色關得掉它——它只看
    ///      「最後一次提交承諾到現在過了多久」。營運方關得掉的逃生門，
    ///      在最需要它的那一天剛好不存在。
    function setWithdrawalsEnabled(bool enabled) external onlyRole(OPERATOR_ROLE) {
        withdrawalsEnabled = enabled;
        emit WithdrawalsToggled(enabled);
    }

    // ───────────────────────── 查詢 ─────────────────────────

    /// @notice 償付能力：帳本宣稱欠多少、池子裡實際有多少。
    /// @dev 給揭露頁用。任何人都呼叫得了，不需要索引全鏈——這是重點，
    ///      一個要先跑索引器才能做的檢查，實際上等於沒有人會做。
    function solvency()
        external
        view
        returns (uint256 owedKg, uint256 heldKg, uint256 owedCash, uint256 heldCash)
    {
        Commitment memory c = commitments[epoch];
        return (c.totalKg, totalHeldKg, c.totalCash, cash.balanceOf(address(this)));
    }

    function supportsInterface(bytes4 interfaceId) public view override(AccessControl, ERC1155Holder) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
