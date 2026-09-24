// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title MerkleSumTree
/// @notice 帶總額的 Merkle 樹：每個節點除了雜湊，還帶著子樹的總額。
///
/// ## 為什麼不能用普通的 Merkle 樹
///
/// 普通 Merkle 樹只證明「這片葉子在樹裡」。它擋不住交易所**把某些使用者的餘額
/// 排除在樹外**——排掉幾個人，樹仍然自洽，每個還在樹裡的人也都驗得過，
/// 而總負債看起來變小了，於是償付能力看起來充足。被排掉的人只有在提領時才會發現，
/// 而那時候交易所已經不在了。
///
/// 帶總額的樹把這件事變成可檢查的：root 上的總額就是**所有葉子的總和**，
/// 少算一片葉子就得少算它的金額。配上「每個使用者自己確認葉子在樹裡」，
/// 兩件事合起來才構成「負債證明」：
///
///   · root.sum 對得上 Bank 合約在鏈上真的持有多少   → 沒有超額發行
///   · 每個人都驗得到自己那片葉子在樹裡              → 沒有人被漏掉
///
/// 缺任何一半都不成立。只有 root.sum 的話，交易所可以少放幾個人；
/// 只有包含性證明的話，交易所可以宣稱一個比實際負債小的總數。
///
/// ## 兩個總額
///
/// 每個節點帶兩個數：碳權總公斤數與結算幣總額。碳權按 batchId 分開的細目
/// 放在葉子裡的 `assetsRoot`（另一棵小樹），這裡加總的是**跨所有批次的總公斤數**——
/// 因為 Bank 合約在鏈上持有的總量是一個數，要能直接對照。
/// 逐批次的對照另外用 `totalsHash` 承諾的明細表做（見 Bank）。
///
/// ## 雜湊格式
///
/// 內部節點與葉子用**不同的前綴**，否則可以拿一個內部節點冒充葉子
/// （second preimage attack）。這是 Merkle 樹的老問題，不是本設計的巧思，
/// 但漏掉就是一個提領漏洞。
library MerkleSumTree {
    /// @dev 葉子與節點的網域分隔前綴
    bytes1 internal constant LEAF_PREFIX = 0x00;
    bytes1 internal constant NODE_PREFIX = 0x01;

    error SumOverflow();
    error BadProofLength();

    struct Node {
        bytes32 hash;
        uint256 kg; // 碳權總公斤數（跨所有批次）
        uint256 cash; // 結算幣總額（最小單位）
    }

    /// @notice 一片葉子＝一個帳戶在這個 epoch 的餘額。
    /// @param account   帳戶地址（智能合約錢包）
    /// @param epoch     這片葉子屬於哪一次承諾。帶著它，舊 epoch 的證據就不能拿來用
    /// @param assetsRoot 這個帳戶各批次持有量的小樹 root（逐批次細目）
    /// @param kg        跨所有批次的總公斤數，要等於 assetsRoot 那棵樹的總和
    /// @param cash      結算幣餘額
    function leaf(address account, uint64 epoch, bytes32 assetsRoot, uint256 kg, uint256 cash)
        internal
        pure
        returns (Node memory)
    {
        return Node({
            hash: keccak256(abi.encodePacked(LEAF_PREFIX, account, epoch, assetsRoot, kg, cash)),
            kg: kg,
            cash: cash
        });
    }

    /// @notice 把兩個節點合成父節點。總額相加，雜湊把**兩邊的總額也一起蓋進去**——
    ///         不蓋的話，總額就不是被雜湊保護的，可以隨便宣稱。
    function parent(Node memory l, Node memory r) internal pure returns (Node memory) {
        unchecked {
            uint256 kg = l.kg + r.kg;
            uint256 cash = l.cash + r.cash;
            if (kg < l.kg || cash < l.cash) revert SumOverflow();
            return Node({
                hash: keccak256(abi.encodePacked(NODE_PREFIX, l.hash, l.kg, l.cash, r.hash, r.kg, r.cash)),
                kg: kg,
                cash: cash
            });
        }
    }

    /// @notice 驗證一片葉子在 root 之下。
    /// @param node     要證明的葉子（或子樹）
    /// @param siblings 從葉子往上的兄弟節點
    /// @param path     位元圖：第 i 位為 1 代表**這一層的兄弟在左邊**（自己在右邊）
    /// @return 算出來的 root 節點（呼叫端自己比對雜湊與總額）
    ///
    /// @dev path 用位元圖而不是 bool[]，是為了讓證據在 calldata 裡小一點——
    ///      提領要付這筆錢，而樹深了之後每一層都是 32 bytes 的 bool。
    function computeRoot(Node memory node, Node[] memory siblings, uint256 path)
        internal
        pure
        returns (Node memory)
    {
        if (siblings.length > 255) revert BadProofLength();
        for (uint256 i = 0; i < siblings.length; i++) {
            bool siblingOnLeft = (path >> i) & 1 == 1;
            node = siblingOnLeft ? parent(siblings[i], node) : parent(node, siblings[i]);
        }
        return node;
    }

    /// @notice 逐批次細目那棵小樹的葉子：(batchId, kg)。
    /// @dev 這一棵不需要帶總額——它的總和已經被外層葉子的 `kg` 欄位承諾了，
    ///      而外層那個數又被外層的 sum tree 保護。多做一次只是多花 gas。
    function assetLeaf(uint256 batchId, uint256 kg) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(LEAF_PREFIX, batchId, kg));
    }

    /// @notice 普通（不帶總額）的 Merkle 驗證，給 assetsRoot 那棵小樹用。
    function computeAssetRoot(bytes32 node, bytes32[] memory siblings, uint256 path)
        internal
        pure
        returns (bytes32)
    {
        for (uint256 i = 0; i < siblings.length; i++) {
            bool siblingOnLeft = (path >> i) & 1 == 1;
            node = siblingOnLeft
                ? keccak256(abi.encodePacked(NODE_PREFIX, siblings[i], node))
                : keccak256(abi.encodePacked(NODE_PREFIX, node, siblings[i]));
        }
        return node;
    }
}
