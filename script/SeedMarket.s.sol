// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {KYCRegistry} from "../src/identity/KYCRegistry.sol";
import {CarbonRegistry} from "../src/registry/CarbonRegistry.sol";
import {CarbonCredit1155} from "../src/registry/CarbonCredit1155.sol";
import {Listing} from "../src/market/Listing.sol";
import {MockTWD} from "../src/mocks/MockTWD.sol";

/// @notice 為 landing page 的行情圖鋪一段**真實的**成交歷史。
///
/// 圖表完全由鏈上 Listing 的 Filled 事件推導，不吃任何假資料，所以 demo 要有
/// 像樣的走勢就得真的成交那麼多筆。這支腳本負責前半段：核發一批額度、
/// 依一條決定性的價格路徑掛出 N 筆單。後半段（逐筆買進並推進區塊時間）
/// 由 script/seed-market.sh 執行，這樣每筆成交才會落在不同的時間戳上。
///
/// 用法（部署完成後）：
///   forge script script/SeedMarket.s.sol --rpc-url anvil --broadcast --sig "seed()"
///   ./script/seed-market.sh
contract SeedMarket is Script {
    uint256 constant PK_DEPLOYER = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant PK_A = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant PK_B = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant PK_ALICE = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    /// 掛單筆數 = 之後的成交筆數
    uint256 constant N = 72;
    /// 每筆成交量（kg）
    uint256 constant LOT_KG = 2_000;
    /// 起始價：每噸 800 mTWD（與 DemoFlow 的第一筆掛單一致）
    uint256 constant START = 800e6;

    KYCRegistry kyc;
    CarbonRegistry registry;
    CarbonCredit1155 credit;
    Listing listing;
    MockTWD twd;

    function seed() external {
        _load();

        address companyA = vm.addr(PK_A);
        uint256 need = N * LOT_KG;

        // 1. 核發足夠的額度給 companyA（查驗簽章由 Phase 0 的服務金鑰代簽）
        vm.startBroadcast(PK_A);
        uint256 pid = registry.registerProject(
            unicode"沼氣回收發電", "ISO 14064-2 / WM-03", "Pingtung, TW", "ipfs://seed"
        );
        vm.stopBroadcast();
        uint256 batch = _issue(pid, need, keccak256("TW-2025-WM03-SEED"));

        // 2. 買方的結算幣
        vm.startBroadcast(PK_DEPLOYER);
        twd.mint(vm.addr(PK_ALICE), 500_000_000e6);
        twd.mint(vm.addr(PK_B), 500_000_000e6);
        vm.stopBroadcast();

        // 3. 依決定性價格路徑掛出 N 筆單（每筆一個價位，之後逐筆成交 → 一條走勢）
        vm.startBroadcast(PK_A);
        credit.setApprovalForAll(address(listing), true);
        uint256 price = START;
        uint256 first = listing.nextOrderId();
        for (uint256 i = 0; i < N; i++) {
            price = _walk(price, i);
            listing.list(batch, LOT_KG, price, 0);
        }
        vm.stopBroadcast();

        console2.log("seed batch      ", batch);
        console2.log("first orderId   ", first);
        console2.log("order count     ", N);
        console2.log("lot kg          ", LOT_KG);
        console2.log("companyA        ", companyA);
    }

    /// @dev 決定性的隨機漫步：有輕微上行趨勢，並限制在 560–1240 之間，
    ///      走勢看起來才像市場而不是鋸齒。用 keccak 當亂數源，重跑結果一致。
    function _walk(uint256 p, uint256 i) internal pure returns (uint256) {
        uint256 r = uint256(keccak256(abi.encode("co2", i))) % 1000;
        // -3.0% ~ +3.4%（偏多 0.2%，模擬緩升）
        int256 bps = int256(r) * 64 / 1000 - 30; // -30 ~ +34（千分比）
        int256 next = int256(p) + (int256(p) * bps) / 1000;
        if (next < int256(560e6)) next = int256(560e6);
        if (next > int256(1240e6)) next = int256(1240e6);
        return uint256(next);
    }

    function _issue(uint256 projectId, uint256 amountKg, bytes32 serial) internal returns (uint256 batchId) {
        CarbonRegistry.IssuanceAttestation memory a = CarbonRegistry.IssuanceAttestation({
            projectId: projectId,
            monitoringStart: 1735689600,
            monitoringEnd: 1767139200,
            amountKg: amountKg,
            serialHash: serial,
            reportHash: keccak256("ISO14064-3 seed report"),
            attestationId: 2,
            deadline: block.timestamp + 1 days
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK_DEPLOYER, registry.hashIssuance(a));
        vm.startBroadcast(PK_DEPLOYER);
        batchId = registry.issue(a, abi.encodePacked(r, s, v));
        vm.stopBroadcast();
    }

    function _load() internal {
        string memory j = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        kyc = KYCRegistry(vm.parseJsonAddress(j, ".kycRegistry"));
        registry = CarbonRegistry(vm.parseJsonAddress(j, ".carbonRegistry"));
        credit = CarbonCredit1155(vm.parseJsonAddress(j, ".carbonCredit1155"));
        listing = Listing(vm.parseJsonAddress(j, ".listing"));
        twd = MockTWD(vm.parseJsonAddress(j, ".settlementToken"));
    }
}
