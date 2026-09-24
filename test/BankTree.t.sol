// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MerkleSumTree} from "../src/bank/MerkleSumTree.sol";

/// 餘額樹的**跨語言一致性**測試。
///
/// 樹有兩份實作：`web/lib/bank/tree.ts` 建樹並產生證據，`MerkleSumTree.sol` 在提領時驗證。
/// 兩邊的雜湊格式必須逐位元組一致，而「兩份實作、一份規格」這種東西不會靠人盯著保持同步。
///
/// 所以這支測試讀 TS 那邊產生的 fixture（`npm run gen:tree-fixture`），
/// 拿 Solidity 重算一次 root。任何一邊改了雜湊格式、排序規則或落單節點的處理方式，
/// 這裡就會紅。
///
/// 不一致的後果值得再說一次：不是測試紅一條，是使用者拿著完全正確的餘額卻領不到錢，
/// 而且要等到有人真的去提領才會發現。
contract BankTreeTest is Test {
    using stdJson for string;

    string internal fixture;

    function setUp() public {
        fixture = vm.readFile("test/fixtures/balance-tree.json");
    }

    function test_rootMatchesTypeScript() public view {
        bytes32 expected = fixture.readBytes32(".root");
        uint256 n = fixture.readUint(".caseCount");

        for (uint256 i = 0; i < n; i++) {
            string memory k = string.concat(".cases[", vm.toString(i), "]");
            MerkleSumTree.Node memory leaf = MerkleSumTree.leaf(
                fixture.readAddress(string.concat(k, ".account")),
                uint64(fixture.readUint(".epoch")),
                fixture.readBytes32(string.concat(k, ".assetsRoot")),
                fixture.readUint(string.concat(k, ".leafKg")),
                fixture.readUint(string.concat(k, ".leafCash"))
            );

            MerkleSumTree.Node[] memory siblings = _siblings(k);
            MerkleSumTree.Node memory root =
                MerkleSumTree.computeRoot(leaf, siblings, fixture.readUint(string.concat(k, ".path")));

            assertEq(root.hash, expected, unicode"root 對不上 TypeScript 算出來的");
            assertEq(root.kg, fixture.readUint(".totalKg"), unicode"總公斤數對不上");
            assertEq(root.cash, fixture.readUint(".totalCash"), unicode"總結算幣對不上");
        }
    }

    /// 資產小樹（逐批次持有）的證據也要一致。
    function test_assetProofMatchesTypeScript() public view {
        uint256 n = fixture.readUint(".caseCount");
        for (uint256 i = 0; i < n; i++) {
            string memory k = string.concat(".cases[", vm.toString(i), "]");
            if (!fixture.readBool(string.concat(k, ".hasAsset"))) continue;

            bytes32 computed = MerkleSumTree.computeAssetRoot(
                MerkleSumTree.assetLeaf(
                    fixture.readUint(string.concat(k, ".asset.batchId")),
                    fixture.readUint(string.concat(k, ".asset.kg"))
                ),
                fixture.readBytes32Array(string.concat(k, ".asset.siblings")),
                fixture.readUint(string.concat(k, ".asset.path"))
            );
            assertEq(computed, fixture.readBytes32(string.concat(k, ".assetsRoot")), unicode"assetsRoot 對不上");
        }
    }

    /// 動過證據就驗不過——這是提領安全的底線，而不是「應該不會有人這樣做」。
    function test_tamperedProofFails() public view {
        bytes32 expected = fixture.readBytes32(".root");
        string memory k = ".cases[0]";
        MerkleSumTree.Node memory leaf = MerkleSumTree.leaf(
            fixture.readAddress(string.concat(k, ".account")),
            uint64(fixture.readUint(".epoch")),
            fixture.readBytes32(string.concat(k, ".assetsRoot")),
            fixture.readUint(string.concat(k, ".leafKg")) + 1, // 多報一公斤
            fixture.readUint(string.concat(k, ".leafCash"))
        );
        MerkleSumTree.Node memory root =
            MerkleSumTree.computeRoot(leaf, _siblings(k), fixture.readUint(string.concat(k, ".path")));
        assertTrue(root.hash != expected, unicode"改了餘額還驗得過，樹就沒有意義");
    }

    /// 只改總額、不改雜湊，也要被擋下來。
    ///
    /// 這一條測的是 `parent()` 有沒有把**子節點的總額**一起蓋進雜湊。沒蓋的話，
    /// 總額就不是被雜湊保護的欄位——提領的人可以宣稱一個比較大的兄弟總額，
    /// 讓 root 的總額對上合約記的 totalKg，而雜湊照樣通過。
    /// 那是這類樹最典型的漏洞，而且從 root 雜湊上完全看不出來。
    function test_sumIsCoveredByHash() public pure {
        MerkleSumTree.Node memory a = MerkleSumTree.Node({hash: keccak256("a"), kg: 100, cash: 0});
        MerkleSumTree.Node memory b = MerkleSumTree.Node({hash: keccak256("b"), kg: 100, cash: 0});
        MerkleSumTree.Node memory bInflated = MerkleSumTree.Node({hash: keccak256("b"), kg: 900, cash: 0});

        assertTrue(
            MerkleSumTree.parent(a, b).hash != MerkleSumTree.parent(a, bInflated).hash,
            unicode"同樣的子雜湊、不同的子總額，父雜湊必須不同"
        );
    }

    function _siblings(string memory k) internal view returns (MerkleSumTree.Node[] memory out) {
        uint256 m = fixture.readUint(string.concat(k, ".siblingCount"));
        out = new MerkleSumTree.Node[](m);
        for (uint256 j = 0; j < m; j++) {
            string memory s = string.concat(k, ".siblings[", vm.toString(j), "]");
            out[j] = MerkleSumTree.Node({
                hash: fixture.readBytes32(string.concat(s, ".hash")),
                kg: fixture.readUint(string.concat(s, ".kg")),
                cash: fixture.readUint(string.concat(s, ".cash"))
            });
        }
    }
}
