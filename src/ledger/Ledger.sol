// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleSumTree} from "../bank/MerkleSumTree.sol";
import {LedgerMerkle} from "./LedgerMerkle.sol";

/// @title Ledger
/// @notice 交易所在鏈上的全部：**每一期的壓縮證據**、授權金鑰清單、結算幣託管、碳權請求權登記。
///
/// ## 鏈上只放證據（設計 v4，2026-09-28 定案）
///
/// 登錄簿（轄區、專案、核發、註銷憑證、對帳報告）、身分、委託單、成交，**全部在鏈下帳本**
/// （`web/lib/ledger/`）。這份合約每小時收一筆承諾：
///
/// ```
/// anchor_k = H( anchor_{k-1}, epoch, logRoot, balanceRoot, registryRoot, identityRoot,
///               totalKg, totalCash, totalsHash, upToBlock, lastSeq, rulesVersion )
/// ```
///
/// 任何人拿到帳本（分層公開：登錄簿全文公開、個人資料給本人、完整紀錄給主管機關與查核機構）
/// 都能重播出同一串 anchor。合約負責的是「提交過就改不掉」，不負責「算得對不對」——
/// 那由重播驗證。
///
/// ## 合約還負責的四件事
///
///   1. **授權金鑰清單**。帳本裡的核發、身分、凍結…都要由有授權的金鑰簽。清單如果放在帳本裡，
///      營運方就能在帳本裡自己加一個假的查驗機構而重播照樣自洽。所以清單在這裡，由國家 Safe 管，
///      重播從這份合約的事件讀出每一把金鑰在哪一段區塊區間有效。
///   2. **結算幣託管**。TWDC 是別人發行的鏈上資產，存入與提領是真的轉帳；
///      承諾的 `totalCash` 不得超過合約實際持有——這是合約唯一當場驗得了的償付能力條件。
///   3. **逃生門**。超過 72 小時沒有新承諾（時間，不是期數：每小時一期的話「3 期」只有 3 小時，
///      一次節點維護就會誤觸），任何人憑最後一期的證據提領結算幣，沒有任何角色關得掉。
///   4. **碳權請求權登記**。碳權不在鏈上，所以逃生時不是「領走」，而是憑證據在這裡**登記請求權**：
///      合約驗過持有與批次後留下改不掉的紀錄，實際移轉由接手單位（主管機關）依紀錄辦理——
///      這和法規「移轉由中央主管機關執行」（溫室氣體減量額度交易拍賣及移轉管理辦法 §26）同一個方向。
contract Ledger is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant SOVEREIGN_ROLE = keccak256("SOVEREIGN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    /// @dev 提交承諾的服務金鑰。只能提交——關不掉逃生門、動不了資產、改不了授權清單。
    bytes32 public constant COMMITTER_ROLE = keccak256("COMMITTER_ROLE");

    /// @dev 帳本裡的授權角色（對應 web/lib/ledger/authorities.ts 的 ROLES）。
    ///      用字串雜湊而不是 enum：新增角色不必改合約。
    bytes32 public constant AUTH_SOVEREIGN = keccak256("SOVEREIGN");
    bytes32 public constant AUTH_OPERATOR = keccak256("OPERATOR");
    bytes32 public constant AUTH_IDENTITY_VERIFIER = keccak256("IDENTITY_VERIFIER");
    bytes32 public constant AUTH_CARBON_VERIFIER = keccak256("CARBON_VERIFIER");
    bytes32 public constant AUTH_DOCUMENT_SIGNER = keccak256("DOCUMENT_SIGNER");
    bytes32 public constant AUTH_AUDITOR = keccak256("AUDITOR");
    bytes32 public constant AUTH_RECEIPT_SIGNER = keccak256("RECEIPT_SIGNER");

    uint256 public constant ESCAPE_AFTER = 72 hours;
    /// @dev 登錄簿葉子的型別標籤（web/lib/ledger/trees.ts 的 TAG）
    uint8 internal constant TAG_BATCH = 3;

    IERC20 public immutable cash;

    struct Commitment {
        bytes32 logRoot;
        bytes32 balanceRoot;
        bytes32 registryRoot;
        bytes32 identityRoot;
        uint256 totalKg;
        uint256 totalCash;
        bytes32 totalsHash;
        uint64 upToBlock;
        uint64 lastSeq;
        uint16 rulesVersion;
        uint64 committedAt;
    }

    bytes32 public head;
    uint64 public epoch;
    mapping(uint64 => Commitment) internal _commitments;

    mapping(bytes32 => mapping(address => bool)) public isAuthority;

    bool public withdrawalsEnabled;
    /// @dev 對某一期證據已經領走／登記了多少。累計制：上限是「最新 root 說你有的，減掉對同一個 root 已經用掉的」。
    mapping(address => mapping(uint64 => uint256)) public withdrawnCash;
    mapping(address => mapping(uint64 => mapping(uint256 => uint256))) public claimedKg;

    event AuthorityGranted(bytes32 indexed role, address indexed account);
    event AuthorityRevoked(bytes32 indexed role, address indexed account);
    /// @dev 整包承諾內容一起發出來：重播的人不必再逐期呼叫 `commitmentOf`。
    event Committed(uint64 indexed epoch, bytes32 anchor, CommitInput commitment);
    event CashDeposited(address indexed account, uint256 amount);
    event CashWithdrawn(address indexed account, uint256 amount, uint64 epoch);
    event CashShortfall(address indexed account, uint256 owed, uint256 paid, uint64 epoch);
    event CreditClaimed(
        address indexed account, uint256 indexed batchId, uint256 amountKg, uint64 epoch,
        uint256 projectId, uint16 vintageYear, bytes32 serialHash
    );
    event WithdrawalsToggled(bool enabled);

    error ZeroAmount();
    error ZeroAddress();
    error ChainBroken(bytes32 expected, bytes32 got);
    error EpochOutOfOrder(uint64 expected, uint64 got);
    error BadUpToBlock(uint64 upToBlock, uint256 current);
    error BadLastSeq(uint64 given, uint64 previous);
    error Insolvent(uint256 owed, uint256 held);
    error WithdrawalsDisabled();
    error NotLatestEpoch(uint64 latest, uint64 got);
    error UnknownEpoch(uint64 epoch);
    error BadProof();
    error SumMismatch(uint256 expected, uint256 got);
    error NothingLeft(address account, uint64 epoch);

    constructor(address cash_, address admin, address sovereign, address operator) {
        if (cash_ == address(0) || admin == address(0) || sovereign == address(0) || operator == address(0)) revert ZeroAddress();
        cash = IERC20(cash_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SOVEREIGN_ROLE, sovereign);
        _grantRole(OPERATOR_ROLE, operator);
        _setRoleAdmin(COMMITTER_ROLE, OPERATOR_ROLE);
    }

    // ───────────────────────── 授權金鑰清單 ─────────────────────────

    /// @notice 授予帳本角色。重播以這個事件所在的區塊為生效起點。
    function grantAuthority(bytes32 role, address account) external onlyRole(SOVEREIGN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (isAuthority[role][account]) return;
        isAuthority[role][account] = true;
        emit AuthorityGranted(role, account);
    }

    /// @notice 撤銷帳本角色。撤銷之後，收單時高度在這一塊以後的事件就不再被這把金鑰授權。
    function revokeAuthority(bytes32 role, address account) external onlyRole(SOVEREIGN_ROLE) {
        if (!isAuthority[role][account]) return;
        isAuthority[role][account] = false;
        emit AuthorityRevoked(role, account);
    }

    // ───────────────────────── 承諾 ─────────────────────────

    /// @dev 參數包成 struct：十二個欄位直接攤開會 stack too deep。
    struct CommitInput {
        bytes32 prev;
        uint64 epoch;
        bytes32 logRoot;
        bytes32 balanceRoot;
        bytes32 registryRoot;
        bytes32 identityRoot;
        uint256 totalKg;
        uint256 totalCash;
        bytes32 totalsHash;
        uint64 upToBlock;
        uint64 lastSeq;
        uint16 rulesVersion;
    }

    /// @notice 提交一期承諾。
    /// @dev 呼叫端帶著它算出來的 `prev`：併發或重送時，接錯位置會被擋下而不是安靜地接在別處。
    ///      合約不驗 root 算得對不對——它沒有帳本。它驗的是：串連、期數、區塊與序號單調、
    ///      以及結算幣的償付能力。
    function commit(CommitInput calldata c) external onlyRole(COMMITTER_ROLE) returns (bytes32 anchor) {
        if (c.prev != head) revert ChainBroken(head, c.prev);
        if (c.epoch != epoch + 1) revert EpochOutOfOrder(epoch + 1, c.epoch);
        uint256 held = cash.balanceOf(address(this));
        if (c.totalCash > held) revert Insolvent(c.totalCash, held);
        Commitment storage last = _commitments[epoch];
        if (c.upToBlock > block.number || (epoch > 0 && c.upToBlock <= last.upToBlock)) revert BadUpToBlock(c.upToBlock, block.number);
        if (c.lastSeq < last.lastSeq) revert BadLastSeq(c.lastSeq, last.lastSeq);

        anchor = anchorOf(c);
        head = anchor;
        epoch = c.epoch;
        _commitments[c.epoch] = Commitment({
            logRoot: c.logRoot,
            balanceRoot: c.balanceRoot,
            registryRoot: c.registryRoot,
            identityRoot: c.identityRoot,
            totalKg: c.totalKg,
            totalCash: c.totalCash,
            totalsHash: c.totalsHash,
            upToBlock: c.upToBlock,
            lastSeq: c.lastSeq,
            rulesVersion: c.rulesVersion,
            committedAt: uint64(block.timestamp)
        });
        emit Committed(c.epoch, anchor, c);
    }

    /// @notice anchor 公式。**與 web/lib/ledger/trees.ts 的 anchorOf 相同**，改一邊就要改另一邊。
    /// @dev 全部欄位都是靜態型別，所以 `abi.encode(c)` 等於把十二個欄位依序 `abi.encode`——
    ///      TypeScript 那邊就是那樣算的。寫成單一 struct 只是為了避開 stack too deep。
    function anchorOf(CommitInput calldata c) public pure returns (bytes32) {
        return keccak256(abi.encode(c));
    }

    function commitmentOf(uint64 e) external view returns (Commitment memory) {
        return _commitments[e];
    }

    // ───────────────────────── 結算幣 ─────────────────────────

    /// @notice 把結算幣存進交易所。這是鏈上轉帳；帳本以這個事件（txHash + logIndex）記一筆 cashDeposit。
    function depositCash(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        cash.safeTransferFrom(msg.sender, address(this), amount);
        emit CashDeposited(msg.sender, amount);
    }

    // ───────────────────────── 逃生門 ─────────────────────────

    function escapeActive() public view returns (bool) {
        uint64 at = _commitments[epoch].committedAt;
        if (at == 0) return false;
        return block.timestamp > uint256(at) + ESCAPE_AFTER;
    }

    function escapeIn() external view returns (uint256) {
        uint64 at = _commitments[epoch].committedAt;
        if (at == 0) return type(uint256).max;
        uint256 t = uint256(at) + ESCAPE_AFTER;
        return block.timestamp >= t ? 0 : t - block.timestamp;
    }

    /// @notice 帳戶在最新一期餘額樹裡的那片葉子與路徑。
    struct BalanceProof {
        uint64 proofEpoch;
        bytes32 assetsRoot;
        uint256 leafKg;
        uint256 leafCash;
        MerkleSumTree.Node[] siblings;
        uint256 path;
    }

    function withdrawCash(uint256 amount, BalanceProof calldata p) external {
        bool escape = escapeActive();
        if (!withdrawalsEnabled && !escape) revert WithdrawalsDisabled();
        if (amount == 0) revert ZeroAmount();
        _checkBalance(msg.sender, p);

        uint256 already = withdrawnCash[msg.sender][p.proofEpoch];
        if (already >= p.leafCash) revert NothingLeft(msg.sender, p.proofEpoch);
        uint256 owed = p.leafCash - already;
        if (amount > owed) revert SumMismatch(owed, amount);

        uint256 pay = amount;
        if (escape) {
            // 逃生模式下池子不夠時不 revert：能領多少領多少，差額留在鏈上作為請求補足的依據
            uint256 available = cash.balanceOf(address(this));
            if (available < pay) {
                emit CashShortfall(msg.sender, amount, available, p.proofEpoch);
                pay = available;
            }
        }
        if (pay == 0) revert NothingLeft(msg.sender, p.proofEpoch);
        withdrawnCash[msg.sender][p.proofEpoch] = already + pay;
        cash.safeTransfer(msg.sender, pay);
        emit CashWithdrawn(msg.sender, pay, p.proofEpoch);
    }

    /// @notice 批次在登錄簿樹裡的那片葉子（欄位與 web/lib/ledger/trees.ts 的 batchContent 相同）。
    struct BatchLeaf {
        uint256 id;
        uint256 projectId;
        uint64 monitoringStart;
        uint64 monitoringEnd;
        uint16 vintageYear;
        bytes32 serialHash;
        bytes32 reportHash;
        address verifier;
        uint64 issuedAt;
        uint256 issuedKg;
        uint256 retiredKg;
        bool frozen;
    }

    struct CreditProof {
        uint256 batchKg; // 這個帳戶在這一批的持有（資產小樹的葉子）
        bytes32[] assetSiblings;
        uint256 assetPath;
        BatchLeaf batch;
        bytes32[] registrySiblings;
        uint256 registryPath;
    }

    /// @notice 碳權請求權登記。**不轉任何東西**——碳權不在鏈上。
    /// @dev 驗三件事：帳戶在最新一期餘額樹裡、這一批在他的資產小樹裡、這一批確實在同一期的登錄簿裡。
    ///      通過後留下一筆改不掉、帶時間的 `CreditClaimed`，接手單位依此辦理移轉。
    ///      同一份證據累計登記不能超過持有量。
    function claimCredits(uint256 amountKg, BalanceProof calldata p, CreditProof calldata cp) external {
        bool escape = escapeActive();
        if (!withdrawalsEnabled && !escape) revert WithdrawalsDisabled();
        if (amountKg == 0) revert ZeroAmount();
        _checkBalance(msg.sender, p);

        bytes32 assetLeaf = MerkleSumTree.assetLeaf(cp.batch.id, cp.batchKg);
        if (MerkleSumTree.computeAssetRoot(assetLeaf, cp.assetSiblings, cp.assetPath) != p.assetsRoot) revert BadProof();

        // 靜態 struct 的 abi.encode ＝ 各欄位依序編碼，和 trees.ts 的 batchContent 相同
        bytes32 content = keccak256(abi.encode(TAG_BATCH, cp.batch));
        bytes32 root = LedgerMerkle.computeRoot(LedgerMerkle.leaf(content), cp.registrySiblings, cp.registryPath);
        if (root != _commitments[p.proofEpoch].registryRoot) revert BadProof();

        uint256 already = claimedKg[msg.sender][p.proofEpoch][cp.batch.id];
        if (already + amountKg > cp.batchKg) revert SumMismatch(cp.batchKg - already, amountKg);
        claimedKg[msg.sender][p.proofEpoch][cp.batch.id] = already + amountKg;
        emit CreditClaimed(msg.sender, cp.batch.id, amountKg, p.proofEpoch, cp.batch.projectId, cp.batch.vintageYear, cp.batch.serialHash);
    }

    /// @dev 只接受**最新**一期的證據：舊 root 上的餘額可能已經花掉了。
    function _checkBalance(address account, BalanceProof calldata p) internal view {
        if (p.proofEpoch != epoch) revert NotLatestEpoch(epoch, p.proofEpoch);
        Commitment storage c = _commitments[p.proofEpoch];
        if (c.committedAt == 0) revert UnknownEpoch(p.proofEpoch);
        MerkleSumTree.Node memory leaf = MerkleSumTree.leaf(account, p.proofEpoch, p.assetsRoot, p.leafKg, p.leafCash);
        MerkleSumTree.Node memory root = MerkleSumTree.computeRoot(leaf, p.siblings, p.path);
        if (root.hash != c.balanceRoot) revert BadProof();
        if (root.kg != c.totalKg) revert SumMismatch(c.totalKg, root.kg);
        if (root.cash != c.totalCash) revert SumMismatch(c.totalCash, root.cash);
    }

    // ───────────────────────── 開關與查詢 ─────────────────────────

    /// @dev 正常提領的開關在營運角色手上。逃生模式不受它影響，也沒有任何角色關得掉。
    function setWithdrawalsEnabled(bool enabled) external onlyRole(OPERATOR_ROLE) {
        withdrawalsEnabled = enabled;
        emit WithdrawalsToggled(enabled);
    }

    /// @notice 結算幣的償付能力：帳本最新一期宣稱欠多少、合約實際持有多少。
    function solvency() external view returns (uint256 owedCash, uint256 heldCash, uint64 latestEpoch, uint64 committedAt) {
        Commitment storage c = _commitments[epoch];
        return (c.totalCash, cash.balanceOf(address(this)), epoch, c.committedAt);
    }
}
