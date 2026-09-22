// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {WebAuthn} from "./WebAuthn.sol";

/// @title PasskeyAccount
/// @notice 使用者的鏈上錢包。**一個登入帳號一個錢包，一個錢包可以有很多把 passkey。**
///
/// 為什麼不是「一把 passkey 一個錢包」：passkey 是**裝置**上的東西，錢包是**人**的東西。
/// 把兩者綁死，換一台裝置就等於換一個錢包——舊錢包裡的碳權不會跟過來，
/// 而使用者根本不覺得自己做了「開新戶」這件事。所以地址由登入帳號決定
/// （Factory 的 CREATE2 salt = accountRef），passkey 只是**能操作這個錢包的金鑰之一**：
/// 手機一把、筆電一把、公司電腦一把，任何一把都能簽，任何一把也能被移除。
///
/// 四種事故，四條路（細節見 docs 與平台使用約定書）：
///
///   1. **某一台裝置遺失，還有別台** → 用別台的 passkey `removeKey` 把它撤掉。即時、不需要任何人。
///   2. **所有裝置都遺失** → 沒有任何一把金鑰能簽字，只能走復原：由 `recoveryAgent`
///      （治理 Safe，在鏈下重新驗證身分之後）提案加一把新 passkey，**延遲 `RECOVERY_DELAY`
///      才生效**，期間任何一把現存金鑰都能一鍵否決。地址不變、歷史不斷。
///   3. **登入帳號被盜** → 盜用者簽不了字（私鑰在你的裝置裡），但他能看到你的持倉，
///      也能發動凍結（見下）。他**不能**完成復原：那需要重新通過身分驗證，不是登入。
///   4. **passkey 被盜（裝置被拿走且能解鎖）** → 從別台 `removeKey`；來不及就凍結。
///
/// 凍結是止血，不是懲罰：凍結之後 `execute` 一律擋下，但金鑰管理（加/移除/解凍）還能做——
/// 否則凍結會把使用者自己鎖在門外。解凍需要**一把現存 passkey**或治理方，
/// 所以只拿到登入權的人可以按下凍結（DoS），卻無法在凍結後把你擋在外面。
///
/// Phase 0：交易由平台 relayer 代送（`execute` 任何人可呼叫，授權來自 WebAuthn 簽章），gas 由平台付。
/// Phase 1：換成 ERC-4337 EntryPoint + paymaster；簽章格式與 nonce 語意不變，只換傳輸層。
contract PasskeyAccount is IERC1155Receiver, IERC721Receiver, IERC1271 {
    struct Key {
        bytes32 qx;
        bytes32 qy;
        /// 使用者看得懂的名字：「Luphia 的 iPhone」。只給人看，合約不用。
        string label;
        uint64 addedAt;
        bool active;
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @notice 這個錢包屬於哪一個登入帳號（keccak256 的不可逆參照，不是 email 本身）。
    ///         Factory 用它當 CREATE2 salt，所以同一個登入帳號永遠對到同一個地址。
    bytes32 public immutable accountRef;

    /// @notice 復原代理人（治理 Safe）。只能**提案**，不能直接動錢，也不能略過延遲。
    address public immutable recoveryAgent;

    /// @notice 平台 relayer。它唯一的特權是**凍結**——代送「我要掛失」這個請求，
    ///         讓只通過登入、手上沒有 passkey 的人也止得了血。它不能解凍、不能動錢、
    ///         不能加金鑰。這把鑰匙被偷走的最大後果是有人把大家的錢包凍起來（阻斷服務），
    ///         而每個人都能用自己的 passkey 解開。
    address public immutable operator;

    /// @notice 部署這個帳戶的 Factory。只用來授權那一次 `initialise`。
    address public immutable factory;

    /// @notice 復原提案的等待期。這段時間的意義是「讓真正的持有人有機會否決」。
    uint256 public constant RECOVERY_DELAY = 72 hours;

    uint256 public nonce;
    bool public frozen;

    /// keyId = keccak256(qx, qy)
    mapping(bytes32 => Key) private _keys;
    bytes32[] private _keyIds;
    uint256 public activeKeys;

    /// 進行中的復原提案（一次只有一個）
    struct Recovery {
        bytes32 qx;
        bytes32 qy;
        string label;
        uint64 executeAfter;
    }

    Recovery public pendingRecovery;

    bytes32 private constant DOMAIN = keccak256("CO2Exchange PasskeyAccount v2");

    event Executed(uint256 indexed nonce, uint256 calls);
    event KeyAdded(bytes32 indexed keyId, bytes32 qx, bytes32 qy, string label);
    event KeyRemoved(bytes32 indexed keyId);
    event FrozenSet(bool frozen, address by);
    event RecoveryProposed(bytes32 indexed keyId, uint64 executeAfter);
    event RecoveryCancelled(bytes32 indexed keyId);
    event RecoveryFinalised(bytes32 indexed keyId);

    error InvalidSignature();
    error CallFailed(uint256 index, bytes reason);
    error NotSelf();
    error NotRecoveryAgent();
    error UnknownKey(bytes32 keyId);
    error KeyAlreadyExists(bytes32 keyId);
    error LastKey();
    error AccountFrozen();
    error NoPendingRecovery();
    error RecoveryNotReady(uint64 executeAfter);
    error RecoveryPending();

    /// @dev 只有帳戶自己能改自己——也就是說，必須經過 `execute`，而 `execute` 要一把有效的
    ///      passkey 簽章。這是「加金鑰／移金鑰要由現有金鑰授權」的實作方式。
    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    /// @dev 建構子**不收金鑰**。地址是 CREATE2(salt = accountRef) 算出來的，而 CREATE2 的
    ///      地址取決於 initCode，initCode 含建構子參數——金鑰放進建構子，地址就會隨金鑰變動，
    ///      「同一個登入帳號永遠同一個地址」這句話就不成立了。所以金鑰在部署之後由
    ///      Factory 呼叫 `initialise` 補上，只能補一次。
    constructor(bytes32 accountRef_, address recoveryAgent_, address operator_) {
        accountRef = accountRef_;
        recoveryAgent = recoveryAgent_;
        operator = operator_;
        factory = msg.sender;
    }

    /// @notice 設定第一把金鑰。只有 Factory、且只有在還沒有任何金鑰時能呼叫。
    function initialise(bytes32 qx, bytes32 qy, string calldata label) external {
        if (msg.sender != factory || activeKeys != 0 || _keyIds.length != 0) revert NotSelf();
        _addKey(qx, qy, label);
    }

    receive() external payable {}

    // ───────────────────────── 簽章與執行 ─────────────────────────

    /// @notice 要簽的 digest：綁 chainId、帳戶地址、nonce 與呼叫內容，防跨鏈 / 跨帳戶 / 重放。
    function getDigest(Call[] calldata calls, uint256 nonce_) public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN, block.chainid, address(this), nonce_, keccak256(abi.encode(calls))));
    }

    /// @param keyId 用哪一把金鑰簽的。由呼叫端指明，合約不必逐把試——
    ///              逐把試在金鑰多的時候會讓 gas 隨金鑰數線性上升。
    /// @param signature abi.encode(WebAuthn.WebAuthnAuth)
    function execute(Call[] calldata calls, bytes32 keyId, bytes calldata signature) external {
        if (frozen) revert AccountFrozen();
        bytes32 digest = getDigest(calls, nonce);
        _verify(keyId, digest, signature);
        uint256 n = nonce++;
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
        emit Executed(n, calls.length);
    }

    /// @notice 凍結中仍然可用的那條路：只能對**自己**下指令，而且只限這五件事——
    ///         加金鑰、移金鑰、凍結、解凍、否決復原。
    ///
    ///         為什麼要白名單而不是「target == address(this) 就好」：這條路是唯一
    ///         繞過 `frozen` 檢查的入口，它能碰到什麼，就是凍結實際上擋不住什麼。
    ///         列舉出來，這個界線就寫在合約裡，不必靠「本合約沒有其他會動錢的函式」
    ///         這種會隨著改版失效的推論。
    function executeSelf(Call[] calldata calls, bytes32 keyId, bytes calldata signature) external {
        for (uint256 i = 0; i < calls.length; i++) {
            if (calls[i].target != address(this) || calls[i].value != 0) revert NotSelf();
            if (calls[i].data.length < 4) revert NotSelf();
            bytes4 sel = bytes4(calls[i].data[:4]);
            if (
                sel != this.addKey.selector && sel != this.removeKey.selector && sel != this.freeze.selector
                    && sel != this.unfreeze.selector && sel != this.cancelRecovery.selector
            ) revert NotSelf();
        }
        bytes32 digest = getDigest(calls, nonce);
        _verify(keyId, digest, signature);
        uint256 n = nonce++;
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].target.call(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
        emit Executed(n, calls.length);
    }

    function _verify(bytes32 keyId, bytes32 digest, bytes calldata signature) internal view {
        Key storage k = _keys[keyId];
        if (!k.active) revert UnknownKey(keyId);
        WebAuthn.WebAuthnAuth memory auth = abi.decode(signature, (WebAuthn.WebAuthnAuth));
        if (!WebAuthn.verify(abi.encodePacked(digest), false, auth, k.qx, k.qy)) revert InvalidSignature();
    }

    // ───────────────────────── 金鑰管理 ─────────────────────────

    /// @notice 加一把 passkey（多一台裝置）。要由**現有的**金鑰簽章授權。
    function addKey(bytes32 qx, bytes32 qy, string calldata label) external onlySelf {
        _addKey(qx, qy, label);
    }

    /// @notice 移除一把 passkey（裝置遺失、賣掉、離職）。要由**現有的**金鑰簽章授權。
    /// @dev 不允許移到零把：那會讓錢包永遠動不了，而且是一個「按錯一次就無法挽回」的按鈕。
    function removeKey(bytes32 keyId) external onlySelf {
        Key storage k = _keys[keyId];
        if (!k.active) revert UnknownKey(keyId);
        if (activeKeys == 1) revert LastKey();
        k.active = false;
        activeKeys--;
        emit KeyRemoved(keyId);
    }

    function _addKey(bytes32 qx, bytes32 qy, string memory label) internal {
        bytes32 keyId = keccak256(abi.encode(qx, qy));
        Key storage k = _keys[keyId];
        if (k.active) revert KeyAlreadyExists(keyId);
        if (k.addedAt == 0) _keyIds.push(keyId); // 撤銷後再加回來，不要重複進索引
        _keys[keyId] = Key({qx: qx, qy: qy, label: label, addedAt: uint64(block.timestamp), active: true});
        activeKeys++;
        emit KeyAdded(keyId, qx, qy, label);
    }

    // ───────────────────────── 凍結 ─────────────────────────

    /// @notice 凍結。任何人都可以凍結**自己的**錢包——這裡的「任何人」指的是
    ///         平台 relayer 代送的凍結請求（只要通過登入即可），以及治理方。
    ///         門檻刻意放低：凍結是往安全的方向動，而事故當下最缺的就是時間。
    ///         代價是拿到登入權的人可以騷擾你（見 `unfreeze`）。
    function freeze() external {
        if (msg.sender != operator && msg.sender != recoveryAgent && msg.sender != address(this)) revert NotSelf();
        frozen = true;
        emit FrozenSet(true, msg.sender);
    }

    /// @notice 解凍。門檻高於凍結：要一把**現存的 passkey**（經 `executeSelf`）或治理方。
    ///         這個不對稱是刻意的——只拿到登入權的人凍得起來、解不開，
    ///         所以他能造成的最大傷害是讓你不方便，而不是把你關在門外。
    function unfreeze() external {
        if (msg.sender != recoveryAgent && msg.sender != address(this)) revert NotSelf();
        frozen = false;
        emit FrozenSet(false, msg.sender);
    }

    // ───────────────────────── 復原（全部裝置都遺失） ─────────────────────────

    /// @notice 提案加一把新 passkey。只有 `recoveryAgent` 能提，而且**不會立刻生效**。
    /// @dev 提案本身不是授權：真正的保護是那 72 小時，以及期間任何一把現存金鑰都能否決。
    ///      如果連一把金鑰都不剩（正是這條路存在的理由），就沒有人能否決——
    ///      此時唯一的保護是 recoveryAgent 本身是多簽 + 鏈下身分重驗。
    function proposeRecovery(bytes32 qx, bytes32 qy, string calldata label) external {
        if (msg.sender != recoveryAgent) revert NotRecoveryAgent();
        if (pendingRecovery.executeAfter != 0) revert RecoveryPending();
        pendingRecovery = Recovery({
            qx: qx, qy: qy, label: label, executeAfter: uint64(block.timestamp + RECOVERY_DELAY)
        });
        emit RecoveryProposed(keccak256(abi.encode(qx, qy)), pendingRecovery.executeAfter);
    }

    /// @notice 否決。現存金鑰（經 executeSelf）或治理方都能否決。
    ///         這是「有人正在嘗試接管我的錢包」時，持有人手上的那一票。
    function cancelRecovery() external {
        if (msg.sender != recoveryAgent && msg.sender != address(this)) revert NotSelf();
        if (pendingRecovery.executeAfter == 0) revert NoPendingRecovery();
        bytes32 keyId = keccak256(abi.encode(pendingRecovery.qx, pendingRecovery.qy));
        delete pendingRecovery;
        emit RecoveryCancelled(keyId);
    }

    /// @notice 延遲期滿後把提案的金鑰加進來。任何人都能觸發——這只是執行一個已經
    ///         等過 72 小時、且沒有被否決的決定，所以不必再限制呼叫者。
    function finaliseRecovery() external {
        Recovery memory r = pendingRecovery;
        if (r.executeAfter == 0) revert NoPendingRecovery();
        if (block.timestamp < r.executeAfter) revert RecoveryNotReady(r.executeAfter);
        delete pendingRecovery;
        _addKey(r.qx, r.qy, r.label);
        emit RecoveryFinalised(keccak256(abi.encode(r.qx, r.qy)));
    }

    // ───────────────────────── 查詢 ─────────────────────────

    function keyOf(bytes32 keyId) external view returns (Key memory) {
        return _keys[keyId];
    }

    /// @notice 目前有效的金鑰。給介面列「這個錢包有哪些裝置」用。
    function keys() external view returns (bytes32[] memory ids, Key[] memory out) {
        uint256 n;
        for (uint256 i = 0; i < _keyIds.length; i++) {
            if (_keys[_keyIds[i]].active) n++;
        }
        ids = new bytes32[](n);
        out = new Key[](n);
        uint256 j;
        for (uint256 i = 0; i < _keyIds.length; i++) {
            if (!_keys[_keyIds[i]].active) continue;
            ids[j] = _keyIds[i];
            out[j] = _keys[_keyIds[i]];
            j++;
        }
    }

    // ── ERC-1271：讓其他合約（例如未來的 EIP-712 掛單）能驗此帳戶的簽章 ──
    /// @param signature abi.encode(keyId, WebAuthn.WebAuthnAuth)
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (bytes32 keyId, WebAuthn.WebAuthnAuth memory auth) =
            abi.decode(signature, (bytes32, WebAuthn.WebAuthnAuth));
        Key storage k = _keys[keyId];
        if (!k.active || frozen) return bytes4(0);
        return WebAuthn.verify(abi.encodePacked(hash), false, auth, k.qx, k.qy)
            ? IERC1271.isValidSignature.selector
            : bytes4(0);
    }

    // ── receivers ──
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IERC1155Receiver).interfaceId
            || id == type(IERC721Receiver).interfaceId || id == type(IERC1271).interfaceId;
    }
}
