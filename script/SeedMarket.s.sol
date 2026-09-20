// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {KYCRegistry} from "../src/identity/KYCRegistry.sol";
import {IKYCRegistry} from "../src/interfaces/IKYCRegistry.sol";
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

    /// 每筆最大成交量（kg）。實際成交量由 fills 腳本逐筆變化，這裡是掛單量上限。
    uint256 constant LOT_KG = 2_000;
    /// 起始價：每噸 800 mTWD（與 DemoFlow 的第一筆掛單一致）
    uint256 constant START = 800e6;

    /// 掛單筆數 = 之後的成交筆數。用 SEED_TRADES 覆寫，例如一年份日線：
    ///   SEED_TRADES=1095 forge script script/SeedMarket.s.sol --sig "seed()" ...
    function _count() internal view returns (uint256) {
        return vm.envOr("SEED_TRADES", uint256(72));
    }

    KYCRegistry kyc;
    CarbonRegistry registry;
    CarbonCredit1155 credit;
    Listing listing;
    MockTWD twd;

    function seed() external {
        _load();

        address companyA = vm.addr(PK_A);
        uint256 n = _count();
        uint256 need = n * LOT_KG;

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

        // 2b. 延長買方的身分效期。
        //     DemoFlow 給的憑證效期是一年；要鋪一年以上的歷史，跑到後段時
        //     KYC 會過期、成交被 checkTransfer 擋下來（這是規則正確生效，不是 bug）。
        //     這裡重新簽發一張涵蓋整段模擬期間的憑證。
        uint64 until = uint64(block.timestamp + vm.envOr("SEED_KYC_YEARS", uint256(12)) * 365 days);
        _reattest(vm.addr(PK_ALICE), IKYCRegistry.Tier.Individual, keccak256("TW-ID-A123456789"), until);
        _reattest(vm.addr(PK_B), IKYCRegistry.Tier.Corporate, keccak256("TW-UBN-87654321"), until);
        _reattest(companyA, IKYCRegistry.Tier.Corporate, keccak256("TW-UBN-12345678"), until);

        // 3. 依決定性價格路徑掛出 N 筆單（每筆一個價位，之後逐筆成交 → 一條走勢）
        vm.startBroadcast(PK_A);
        credit.setApprovalForAll(address(listing), true);
        uint256 price = START;
        uint256 first = listing.nextOrderId();
        for (uint256 i = 0; i < n; i++) {
            price = _walk(price, i, n);
            listing.list(batch, LOT_KG, price, 0);
        }
        vm.stopBroadcast();

        console2.log("seed batch      ", batch);
        console2.log("first orderId   ", first);
        console2.log("order count     ", n);
        console2.log("lot kg          ", LOT_KG);
        console2.log("companyA        ", companyA);
    }

    /// @dev 決定性的價格路徑：雜訊 + 往趨勢線的均值回歸。
    ///
    ///      純隨機漫步的變異數隨步數線性成長，跑一年（上千步）會一路撞到上下限，
    ///      看起來就不像市場。所以這裡讓價格被拉向一條緩慢上行的錨定線：
    ///      anchor(i) = START * (1 + 0.25 * i/n)，年漲幅約 25%。
    ///      用 keccak 當亂數源，同樣參數重跑結果一致。
    function _walk(uint256 p, uint256 i, uint256 n) internal pure returns (uint256) {
        uint256 anchor = START + (START * 25 * i) / (100 * n);

        // 雜訊：±1.6%
        uint256 r = uint256(keccak256(abi.encode("co2", i))) % 1000;
        int256 noiseBps = int256(r) * 32 / 1000 - 16;
        int256 next = int256(p) + (int256(p) * noiseBps) / 1000;

        // 均值回歸：往錨定線收斂 6%
        next += (int256(anchor) - next) * 6 / 100;

        if (next < int256(400e6)) next = int256(400e6);
        if (next > int256(2000e6)) next = int256(2000e6);
        return uint256(next);
    }

    /// @dev 以身分驗證服務金鑰重簽一張新效期的憑證（覆寫既有的那張）。
    /// @dev 簽章有效期刻意放很寬（一年）。
    ///
    ///      理由不是安全，是這個坑太難查：forge **模擬**時讀到的是鏈上最後一個區塊的時間戳，
    ///      而 anvil 閒置時不會產生新區塊；等到**送出**交易，anvil 才用真實時間打上時間戳。
    ///      anvil 只要閒置超過 deadline 的長度（原本是一小時），整批交易就會在第一筆
    ///      kyc.register 全部失敗，訊息只有一句 Expired，看不出是時鐘的問題。
    ///      正式環境的 attestation 由簽章服務即時簽發，短效期才是對的——那條路徑不走這裡。
    uint256 internal constant DEMO_SIG_TTL = 365 days;

    function _reattest(address account, IKYCRegistry.Tier tier, bytes32 identityHash, uint64 expiry) internal {
        KYCRegistry.IdentityAttestation memory a = KYCRegistry.IdentityAttestation({
            account: account,
            tier: tier,
            expiry: expiry,
            jurisdiction: bytes2("TW"),
            identityHash: identityHash,
            nonce: kyc.nonces(account),
            deadline: block.timestamp + DEMO_SIG_TTL
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK_DEPLOYER, kyc.hashAttestation(a));
        vm.startBroadcast(PK_DEPLOYER);
        kyc.register(a, abi.encodePacked(r, s, v));
        vm.stopBroadcast();
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
            deadline: block.timestamp + DEMO_SIG_TTL
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
