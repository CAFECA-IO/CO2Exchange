// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {Deploy} from "./Deploy.s.sol";
import {KYCRegistry} from "../src/identity/KYCRegistry.sol";
import {IKYCRegistry} from "../src/interfaces/IKYCRegistry.sol";
import {CarbonRegistry} from "../src/registry/CarbonRegistry.sol";
import {CarbonCredit1155} from "../src/registry/CarbonCredit1155.sol";
import {RetirementCertificate} from "../src/registry/RetirementCertificate.sol";
import {ReserveAttestation} from "../src/registry/ReserveAttestation.sol";

/// @notice 提案展示：部署後跑完整流程（Anvil 預設帳戶）。
///   account0 = 部署者 / 國家單位 / 營運 / 身分驗證服務 / 查驗機構（Phase 0 合一）
///   account1 = 減量企業 companyA
///   account2 = 做市商 companyB
///   account3 = 自然人 alice
///
/// 用法：anvil & ; forge script script/DemoFlow.s.sol --rpc-url anvil --broadcast
contract DemoFlow is Deploy {
    uint256 constant PK_A = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant PK_B = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant PK_ALICE = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    /// @dev 本站自國外登錄簿引入的專案（JP / TH / AU）。在主權角色還在部署者手上時登錄。
    uint256[] public imported;
    /// @dev 每次核發要有不同的 attestationId，否則第二次 issue 會被當成重放。
    uint256 internal _attCounter;

    /// @dev v4 掛載點。核心 demo 不含 v4；DemoFlowV4 覆寫這兩個。
    ///      回傳 false 代表「這次沒有 v4 流動性」，呼叫端改走替代路徑。
    function _demoProvideLiquidity() internal virtual returns (bool) {
        return false;
    }

    function _demoSwap() internal virtual {}

    /// @dev 國外額度：本站在各該國官方登錄簿開立託管帳戶並持有，於本站鏈上登錄為專案。
    ///      擁有者是本站代辦方——使用者買到的是本站對這批託管額度的請求權，
    ///      要註銷時才由本站在該國登錄簿辦理實際移轉與註銷。
    function _seedImportedProjects() internal virtual override {
        imported.push(
            registry.registerImportedProject(
                cfg.operator,
                unicode"北海道 工場鍋爐燃料轉換（重油→天然氣）",
                "J-Credit / EN-S-001",
                "Hokkaido, JP",
                "ipfs://demo-jp",
                "JP",
                "J-Credit"
            )
        );
        imported.push(
            registry.registerImportedProject(
                cfg.operator,
                unicode"清邁 稻殼生質鍋爐替代燃煤",
                "T-VER / T-VER-METH-0003",
                "Chiang Mai, TH",
                "ipfs://demo-th",
                "TH",
                "T-VER"
            )
        );
        imported.push(
            registry.registerImportedProject(
                cfg.operator,
                unicode"昆士蘭 草原造林（人類誘導自然再生）",
                "ACCU / HIR",
                "Queensland, AU",
                "ipfs://demo-au",
                "AU",
                "ACCU"
            )
        );
    }

    function demo() external {
        deployAll();
        address companyA = vm.addr(PK_A);
        address companyB = vm.addr(PK_B);
        address alice = vm.addr(PK_ALICE);

        // 1. 身分：憑證驗證服務簽發 attestation（Phase 0 由 account0 模擬）
        _register(companyA, IKYCRegistry.Tier.Corporate, keccak256("TW-UBN-12345678"));
        _register(companyB, IKYCRegistry.Tier.Corporate, keccak256("TW-UBN-87654321"));
        _register(alice, IKYCRegistry.Tier.Individual, keccak256("TW-ID-A123456789"));

        // 2. 專案登錄 + 查驗機構簽章核發 100 噸
        vm.startBroadcast(PK_A);
        uint256 pid = registry.registerProject(
            unicode"屋頂太陽能替代柴油發電", "ISO 14064-2 / RE-01", "Taoyuan, TW", "ipfs://demo"
        );
        vm.stopBroadcast();
        uint256 batch = _issue(pid, 100_000, keccak256("TW-2025-RE01-000001-100000"));

        // 3. 結算幣
        vm.startBroadcast(cfg.pk);
        twd.mint(alice, 100_000e6);
        twd.mint(companyB, 10_000_000e6);
        vm.stopBroadcast();

        // 4. companyA：30 噸掛單（800/噸），60 噸入池，40 CCT 給做市商
        vm.startBroadcast(PK_A);
        credit.setApprovalForAll(address(listing), true);
        credit.setApprovalForAll(address(pool), true);
        listing.list(batch, 30_000, 800e6, 100);
        pool.deposit(batch, 60_000);
        cct.transfer(companyB, 40e18);
        vm.stopBroadcast();

        // 4b. 國外額度上架：本站持有於各國登錄簿的託管額度，登錄到鏈上後掛單。
        //     故意排在國內額度之後——掛單簿第一筆是國內的，示範的敘事也是在地優先。
        _register(cfg.operator, IKYCRegistry.Tier.Corporate, keccak256("TW-UBN-53212539"));
        uint256 jp = _issue(imported[0], 40_000, keccak256("JP-2025-JC-000001-040000"));
        uint256 th = _issue(imported[1], 25_000, keccak256("TH-2025-TVER-000001-025000"));
        uint256 au = _issue(imported[2], 15_000, keccak256("AU-2025-ACCU-000001-015000"));
        vm.startBroadcast(cfg.pk);
        credit.setApprovalForAll(address(listing), true);
        listing.list(jp, 20_000, 950e6, 100);
        listing.list(th, 15_000, 320e6, 100);
        listing.list(au, 10_000, 780e6, 100);
        vm.stopBroadcast();

        // 5. companyB：有 v4 就提供流動性；沒有就直接把 CCT 轉給 alice，讓贖回 / 註銷流程仍有資料
        vm.startBroadcast(PK_B);
        if (!_demoProvideLiquidity()) {
            cct.transfer(alice, 5e18); // 5 噸
        }
        vm.stopBroadcast();

        // 6. alice（自然人）：掛單買 2 噸、v4 買 4000 元，然後把手上的額度轉售給 companyB。
        //    自然人不能註銷——官方登錄簿沒有他的額度帳戶——所以他的出場方式是轉售。
        vm.startBroadcast(PK_ALICE);
        twd.approve(address(listing), type(uint256).max);
        listing.buy(1, 2_000);
        _demoSwap();
        uint256 aliceCct = cct.balanceOf(alice);
        if (aliceCct > 0) cct.transfer(companyB, aliceCct);
        credit.safeTransferFrom(alice, companyB, batch, 2_000, "");
        vm.stopBroadcast();

        // 7. companyB（法人）：用掉買來的額度，兩條註銷路徑各走一次
        vm.startBroadcast(PK_B);
        uint256 kg = cct.balanceOf(companyB) / 1e15;
        if (kg > 0) {
            pool.redeemAndRetire(
                kg,
                keccak256("TW-UBN-87654321"),
                unicode"某某股份有限公司",
                RetirementCertificate.Purpose.VoluntaryNeutrality,
                unicode"2026 產品碳中和"
            );
        }
        credit.retire(
            CarbonCredit1155.RetireRequest({
                holder: companyB,
                batchId: batch,
                amountKg: 2_000,
                certificateTo: companyB,
                beneficiaryHash: keccak256("TW-UBN-87654321"),
                beneficiary: unicode"某某股份有限公司",
                purpose: RetirementCertificate.Purpose.CarbonFee,
                memo: "FY2025"
            })
        );
        vm.stopBroadcast();

        _publishReserveReport();

        console2.log("--- demo state ---");
        console2.log("batch retiredKg      ", credit.batchOf(batch).retiredKg);
        console2.log("companyB certificates", cert.balanceOf(companyB));
        console2.log("alice CCT            ", cct.balanceOf(alice));
        console2.log("companyB CCT         ", cct.balanceOf(companyB));
        console2.log("companyA mTWD        ", twd.balanceOf(companyA));
        console2.log("listing remainingKg  ", listing.orderOf(1).remainingKg);
        console2.log("pool pooledKg        ", pool.pooledKg(batch));
    }

    /// @dev 第一期託管對帳：各國登錄簿託管帳戶 vs 鏈上流通量、信託專戶 vs 結算幣發行量。
    ///      demo 的數字直接取鏈上真實流通量，所以一定對得起來；正式環境是人工填報 + 查核機構簽署。
    function _publishReserveReport() internal {
        ReserveAttestation.CreditReserve[] memory c = new ReserveAttestation.CreditReserve[](4);
        c[0] = _reserveRow("TW", unicode"環境部 溫室氣體減量額度管理系統", "TW-ACC-0001", 100_000);
        c[1] = _reserveRow("JP", unicode"Ｊ－クレジット登録簿", "JP-ACC-0007", 40_000);
        c[2] = _reserveRow("TH", unicode"TGO T-VER Registry", "TH-ACC-0012", 25_000);
        c[3] = _reserveRow("AU", "ANREU", "AU-ACC-0031", 15_000);

        ReserveAttestation.CashReserve memory cash = ReserveAttestation.CashReserve({
            trustee: unicode"某某商業銀行 信託部",
            accountRef: "TRUST-CO2X-001",
            balance: twd.totalSupply(),
            tokenSupply: twd.totalSupply(),
            statementHash: keccak256(abi.encodePacked("trust statement ", _period()))
        });

        vm.startBroadcast(cfg.pk);
        // 期別由鏈上時間推導，不能寫死。回填模擬會把鏈開在一年前，
        // 寫死的期別會讓第一份報告標著「2026 年 9 月」卻蓋在 2025 年 11 月的基準日上。
        uint256 id = reserve.publish(_period(), uint64(block.timestamp), c, cash);
        reserve.setDocumentHash(id, keccak256(abi.encodePacked("reserve report ", _period(), ".pdf")));
        reserve.attest(
            id,
            ReserveAttestation.Status.Attested,
            unicode"某某會計師事務所",
            unicode"各國託管帳戶餘額與鏈上流通量相符；信託專戶餘額與結算幣發行量相符"
        );
        vm.stopBroadcast();
    }

    /// @dev 目前這一期的期別 YYYYMM（由鏈上時間推導）。
    function _period() internal view returns (uint32) {
        uint256 z = block.timestamp / 86400 + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 m = mp < 10 ? mp + 3 : mp - 9;
        uint256 y = yoe + era * 400 + (m <= 2 ? 1 : 0);
        return uint32(y * 100 + m);
    }

    function _reserveRow(bytes2 country, string memory custodian, string memory ref, uint256 kg)
        internal
        pure
        returns (ReserveAttestation.CreditReserve memory)
    {
        return ReserveAttestation.CreditReserve({
            country: country,
            custodian: custodian,
            accountRef: ref,
            heldKg: kg,
            onchainKg: kg,
            statementHash: keccak256(abi.encodePacked("registry statement ", country))
        });
    }

    /// @dev 簽章有效期刻意放很寬（一年）。
    ///
    ///      理由不是安全，是這個坑太難查：forge **模擬**時讀到的是鏈上最後一個區塊的時間戳，
    ///      而 anvil 閒置時不會產生新區塊；等到**送出**交易，anvil 才用真實時間打上時間戳。
    ///      anvil 只要閒置超過 deadline 的長度（原本是一小時），整批交易就會在第一筆
    ///      kyc.register 全部失敗，訊息只有一句 Expired，看不出是時鐘的問題。
    ///      正式環境的 attestation 由簽章服務即時簽發，短效期才是對的——那條路徑不走這裡。
    uint256 internal constant DEMO_SIG_TTL = 365 days;

    function _register(address account, IKYCRegistry.Tier tier, bytes32 identityHash) internal {
        KYCRegistry.IdentityAttestation memory a = KYCRegistry.IdentityAttestation({
            account: account,
            tier: tier,
            expiry: uint64(block.timestamp + 365 days),
            jurisdiction: bytes2("TW"),
            identityHash: identityHash,
            nonce: kyc.nonces(account),
            deadline: block.timestamp + DEMO_SIG_TTL
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(cfg.pk, kyc.hashAttestation(a));
        vm.startBroadcast(cfg.pk);
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
            reportHash: keccak256("ISO14064-3 verification report"),
            attestationId: ++_attCounter,
            deadline: block.timestamp + DEMO_SIG_TTL
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(cfg.pk, registry.hashIssuance(a));
        vm.startBroadcast(cfg.pk);
        batchId = registry.issue(a, abi.encodePacked(r, s, v));
        vm.stopBroadcast();
    }
}
