// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {MerkleSumTree} from "./MerkleSumTree.sol";
import {LedgerTWD} from "./LedgerTWD.sol";

/// @title Ledger
/// @notice 交易所在鏈上的全部：**每一期的壓縮證據**、授權金鑰清單、新台幣入出金的審計紀錄。
///
/// ## 鏈上只放證據（設計 v4，2026-09-28 定案；新台幣版 2026-09-29）
///
/// 登錄簿（轄區、專案、核發、註銷憑證、對帳報告）、身分、委託單、成交，**全部在鏈下帳本**
/// （`web/lib/ledger/`）。這份合約每小時收一筆承諾：
///
/// ```
/// anchor_k = H( anchor_{k-1}, epoch, logRoot, balanceRoot, registryRoot, identityRoot,
///               totalKg, totalCash, totalsHash, upToBlock, lastSeq, rulesVersion )
/// ```
///
/// 任何人拿到帳本都能重播出同一串 anchor。合約負責的是「提交過就改不掉」，不負責「算得對不對」——
/// 那由重播驗證。
///
/// ## 合約還負責的兩件事
///
///   1. **授權金鑰清單**。帳本裡的核發、身分、凍結…都要由有授權的金鑰簽。清單如果放在帳本裡，
///      營運方就能在帳本裡自己加一個假的查驗機構而重播照樣自洽。所以清單在這裡，由國家 Safe 管。
///   2. **新台幣的審計紀錄**。使用者的錢是真的新台幣，存在信託專戶；鏈上沒有任何人領得走的東西。
///      營運 Safe 確認一筆入金就鑄同額的 `LedgerTWD` 給這份合約自己，匯出一筆出金就銷毀同額。
///      於是 `cash.totalSupply()` 是營運方對「信託專戶裡屬於使用者的錢」的公開聲明，
///      每一期承諾的 `totalCash` 不得超過它——這是合約唯一當場驗得了的償付能力條件。
///      出金另有一道上限：只能銷毀**使用者自己簽過提領請求**、而且已經進了承諾的金額。
///
/// ## 沒有鏈上提領、沒有逃生門
///
/// 平台上的新台幣與碳權都**提不出鏈外錢包**。營運方停擺時，鏈上留下的是證據：最後一期承諾、
/// 每個人的葉子、授權清單與入出金紀錄。返還依契約與信託安排，以這些證據為準。
contract Ledger is AccessControl {

    bytes32 public constant SOVEREIGN_ROLE = keccak256("SOVEREIGN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    /// @dev 提交承諾的服務金鑰。只能提交——鑄不了、銷不了、改不了授權清單。
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

    /// @notice 新台幣的記帳代幣。建構時由這份合約部署，唯一的持有人是這份合約。
    LedgerTWD public immutable cash;

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
    /// @notice 每個帳本角色的門檻：一筆授權事件要有幾把「同時有效」的金鑰簽章（k-of-n）。0 視同 1。
    /// @dev 主權、營運、查核角色用 k-of-n，把國家 Safe 的多簽搬進帳本：查核時只需 ecrecover，
    ///      不必在過去的區塊呼叫 Safe 的 isValidSignature（那需要 archive 節點）。
    mapping(bytes32 => uint8) public thresholdOf;

    /// @dev 這個帳戶**累計**出金（銷毀）多少。只增不減，不分期別——和葉子裡的提領請求累計比，
    ///      怎麼換期、鏡像晚了幾塊，同一筆請求都不會出金第二次。
    mapping(address => uint256) public withdrawnTotal;
    /// @dev 用過的銀行交易參考號（雜湊）。同一筆匯款不能入帳兩次、也不能拿來銷兩次。
    mapping(bytes32 => bool) public bankRefUsed;

    event AuthorityGranted(bytes32 indexed role, address indexed account);
    event AuthorityRevoked(bytes32 indexed role, address indexed account);
    event ThresholdSet(bytes32 indexed role, uint8 threshold);
    /// @dev 整包承諾內容一起發出來：重播的人不必再逐期呼叫 `commitmentOf`。
    event Committed(uint64 indexed epoch, bytes32 anchor, CommitInput commitment);
    /// @notice 一筆新台幣入金已到信託專戶，記到這個帳戶名下（帳本以 txHash + logIndex 鏡像成 cashDeposit）。
    event CashDeposited(address indexed account, uint256 amount, bytes32 indexed bankRef);
    /// @notice 一筆新台幣出金已匯出（帳本鏡像成 cashWithdraw，從待提領銷帳）。
    event CashWithdrawn(address indexed account, uint256 amount, uint64 epoch, bytes32 indexed bankRef);

    error ZeroAmount();
    error BadThreshold(uint8 threshold);
    error ZeroAddress();
    error ChainBroken(bytes32 expected, bytes32 got);
    error EpochOutOfOrder(uint64 expected, uint64 got);
    error BadUpToBlock(uint64 upToBlock, uint256 current);
    error BadLastSeq(uint64 given, uint64 previous);
    error Insolvent(uint256 owed, uint256 held);
    error BankRefUsed(bytes32 bankRef);
    error NotLatestEpoch(uint64 latest, uint64 got);
    error UnknownEpoch(uint64 epoch);
    error BadProof();
    error SumMismatch(uint256 expected, uint256 got);
    error NothingLeft(address account, uint64 epoch);

    constructor(address admin, address sovereign, address operator) {
        if (admin == address(0) || sovereign == address(0) || operator == address(0)) revert ZeroAddress();
        cash = new LedgerTWD();
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

    /// @notice 設定角色門檻。重播以這個事件所在的區塊為生效起點（和授權的增減一樣）。
    /// @dev 門檻高於目前有效的金鑰數時，這個角色就簽不出任何事件——那是國家單位的選擇，合約不擋，
    ///      但查核工具與治理頁會標示出來。
    function setThreshold(bytes32 role, uint8 threshold) external onlyRole(SOVEREIGN_ROLE) {
        if (threshold == 0) revert BadThreshold(threshold);
        thresholdOf[role] = threshold;
        emit ThresholdSet(role, threshold);
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

    // ───────────────────────── 新台幣入出金 ─────────────────────────

    /// @notice 營運 Safe 確認一筆新台幣入金已到信託專戶：鑄同額 TWD 給這份合約，記在帳戶名下。
    /// @param bankRef 銀行交易參考號的雜湊（明文留在營運方與信託銀行）。同一個不能用兩次。
    function creditDeposit(address account, uint256 amount, bytes32 bankRef) external onlyRole(OPERATOR_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _useRef(bankRef);
        cash.mint(amount);
        emit CashDeposited(account, amount, bankRef);
    }

    /// @notice 帳戶在最新一期餘額樹裡的那片葉子與路徑。
    /// @dev `leafRequested`／`leafSettled` 是葉子裡的提領累計（見 MerkleSumTree.leafWithdrawals）。
    struct BalanceProof {
        uint64 proofEpoch;
        bytes32 assetsRoot;
        uint256 leafKg;
        uint256 leafCash;
        uint256 leafRequested;
        uint256 leafSettled;
        MerkleSumTree.Node[] siblings;
        uint256 path;
    }

    /// @notice 營運 Safe 確認一筆新台幣出金已匯出：銷毀同額 TWD。
    ///
    /// 上限用累計比：`leafRequested − withdrawnTotal`。也就是**只能銷毀使用者自己簽過提領請求、
    /// 而且那筆請求已經進了最新一期承諾**的金額——營運方不能憑空把某人的錢「出金」掉，
    /// 帳本裡還在用的錢也不會同時被出金。
    function settleWithdrawal(address account, uint256 amount, bytes32 bankRef, BalanceProof calldata p)
        external
        onlyRole(OPERATOR_ROLE)
    {
        if (amount == 0) revert ZeroAmount();
        _checkBalance(account, p);
        uint256 already = withdrawnTotal[account];
        if (already >= p.leafRequested) revert NothingLeft(account, p.proofEpoch);
        uint256 owed = p.leafRequested - already;
        if (amount > owed) revert SumMismatch(owed, amount);
        _useRef(bankRef);
        withdrawnTotal[account] = already + amount;
        cash.burn(amount);
        emit CashWithdrawn(account, amount, p.proofEpoch, bankRef);
    }

    function _useRef(bytes32 bankRef) internal {
        if (bankRef == bytes32(0) || bankRefUsed[bankRef]) revert BankRefUsed(bankRef);
        bankRefUsed[bankRef] = true;
    }

    /// @dev 只接受**最新**一期的證據：舊 root 上的請求可能已經被退回。
    function _checkBalance(address account, BalanceProof calldata p) internal view {
        if (p.proofEpoch != epoch) revert NotLatestEpoch(epoch, p.proofEpoch);
        Commitment storage c = _commitments[p.proofEpoch];
        if (c.committedAt == 0) revert UnknownEpoch(p.proofEpoch);
        MerkleSumTree.Node memory leaf =
            MerkleSumTree.leafWithdrawals(account, p.proofEpoch, p.assetsRoot, p.leafKg, p.leafCash, p.leafRequested, p.leafSettled);
        MerkleSumTree.Node memory root = MerkleSumTree.computeRoot(leaf, p.siblings, p.path);
        if (root.hash != c.balanceRoot) revert BadProof();
        if (root.kg != c.totalKg) revert SumMismatch(c.totalKg, root.kg);
        if (root.cash != c.totalCash) revert SumMismatch(c.totalCash, root.cash);
    }

    // ───────────────────────── 查詢 ─────────────────────────

    /// @notice 新台幣的償付能力：帳本最新一期宣稱欠多少、鏈上記帳代幣（＝營運方宣稱的信託餘額）多少。
    function solvency() external view returns (uint256 owedCash, uint256 heldCash, uint64 latestEpoch, uint64 committedAt) {
        Commitment storage c = _commitments[epoch];
        return (c.totalCash, cash.balanceOf(address(this)), epoch, c.committedAt);
    }
}
