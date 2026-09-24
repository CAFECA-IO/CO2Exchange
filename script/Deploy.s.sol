// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {KYCRegistry} from "../src/identity/KYCRegistry.sol";
import {RetirementCertificate} from "../src/registry/RetirementCertificate.sol";
import {CarbonCredit1155} from "../src/registry/CarbonCredit1155.sol";
import {CarbonRegistry} from "../src/registry/CarbonRegistry.sol";
import {ReserveAttestation} from "../src/registry/ReserveAttestation.sol";
import {IJurisdictions} from "../src/interfaces/IJurisdictions.sol";
import {Listing} from "../src/market/Listing.sol";
import {FeeSchedule} from "../src/market/FeeSchedule.sol";
import {CarbonCreditToken} from "../src/market/CarbonCreditToken.sol";
import {CarbonPool} from "../src/market/CarbonPool.sol";
import {MockTWD} from "../src/mocks/MockTWD.sol";
import {PasskeyAccountFactory} from "../src/account/PasskeyAccountFactory.sol";
import {Bank} from "../src/bank/Bank.sol";
import {GovernanceLib} from "../src/governance/GovernanceLib.sol";
import {Safe} from "safe-smart-account/Safe.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Phase 0 一鍵部署（Anvil）。
///
/// 環境變數（皆有 Anvil 預設值）：
///   DEPLOYER_PK        部署者私鑰
///   SOVEREIGN          國家單位地址（Phase 0 用 EOA；正式為 Safe + Timelock）
///   OPERATOR           CAFECA 代運營地址
///   TREASURY           手續費收款
///   IDENTITY_VERIFIER  身分驗證服務簽章地址
///   CARBON_VERIFIER    查驗機構簽章地址
///   VINTAGE_YEAR       第一個池的年份（預設 2025）
///
/// 用法：
///   anvil &
///   forge script script/Deploy.s.sol --rpc-url anvil --broadcast
contract Deploy is Script {
    /// @dev Anvil 的預設帳戶 0，只在沒有指定 DEPLOYER_PK 時使用。
    uint256 internal constant ANVIL_PK0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    error DeployerHasNoFunds(address deployer, uint256 chainId);
    error PublicKeyOnPublicChain(string role, address who, uint256 chainId);

    struct Config {
        uint256 pk;
        address deployer;
        address sovereign;
        address operator;
        address treasury;
        address identityVerifier;
        address carbonVerifier;
        address documentSigner; // 憑證 PDF hash 回寫服務
        uint16 vintage;
        // 治理
        address nationalSafe; // 既有 Safe 地址；為 0 則以 nationalOwners/threshold 建立
        address operatorSafe;
        address[] nationalOwners;
        uint256 nationalThreshold;
        address[] operatorOwners;
        uint256 operatorThreshold;
        uint256 timelockDelay;
        uint256 recoveryDelay;
    }

    Config internal cfg;

    // 部署結果放在 storage，避免 stack too deep
    KYCRegistry public kyc;
    RetirementCertificate public cert;
    CarbonCredit1155 public credit;
    CarbonRegistry public registry;
    ReserveAttestation public reserve;
    MockTWD public twd;
    Listing public listing;
    FeeSchedule public feeSchedule;
    CarbonCreditToken public cct;
    CarbonPool public pool;
    // v4 模組的三個地址。核心部署不含 v4，維持 address(0)；
    // DeployV4 會填進來。用 address 而不是具體型別，核心編譯單元才不必 import v4。
    address public poolManager;
    address public hook;
    address public router;
    PasskeyAccountFactory public accountFactory;
    Bank public bank;
    Safe public nationalSafe;
    Safe public operatorSafe;
    TimelockController public timelock;
    GovernanceLib.SafeInfra internal safeInfra;

    function run() external {
        deployAll();
    }

    /// @dev 完整部署 + 佈線 + 移轉。DemoFlow 也走這條路。
    function deployAll() internal {
        _loadConfig();
        _deployGovernance();
        _deployCore();
        _deployAccountFactory();
        _deployV4();
        _wireAsSovereign();
        _wireAsOperator();
        _initPool();
        _handover();
        _print();
        _writeDeployment();
    }

    function _loadConfig() internal {
        cfg.pk = vm.envOr("DEPLOYER_PK", ANVIL_PK0);
        cfg.deployer = vm.addr(cfg.pk);
        cfg.sovereign = vm.envOr("SOVEREIGN", cfg.deployer);
        cfg.operator = vm.envOr("OPERATOR", cfg.deployer);
        cfg.treasury = vm.envOr("TREASURY", cfg.deployer);
        cfg.identityVerifier = vm.envOr("IDENTITY_VERIFIER", cfg.deployer);
        cfg.carbonVerifier = vm.envOr("CARBON_VERIFIER", cfg.deployer);
        cfg.documentSigner = vm.envOr("DOCUMENT_SIGNER", cfg.deployer);
        cfg.vintage = uint16(vm.envOr("VINTAGE_YEAR", uint256(2025)));

        // Phase 0 預設：國家 Safe = Anvil 帳戶 5,6,7（2-of-3）；營運 Safe = 帳戶 8,9（1-of-2）；Timelock 48h
        address[] memory nat = new address[](3);
        nat[0] = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc;
        nat[1] = 0x976EA74026E726554dB657fA54763abd0C3a0aa9;
        nat[2] = 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955;
        address[] memory op = new address[](2);
        op[0] = 0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f;
        op[1] = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;
        cfg.nationalSafe = vm.envOr("NATIONAL_SAFE", address(0));
        cfg.operatorSafe = vm.envOr("OPERATOR_SAFE", address(0));
        cfg.nationalOwners = vm.envOr("NATIONAL_OWNERS", ",", nat);
        cfg.nationalThreshold = vm.envOr("NATIONAL_THRESHOLD", uint256(2));
        cfg.operatorOwners = vm.envOr("OPERATOR_OWNERS", ",", op);
        cfg.operatorThreshold = vm.envOr("OPERATOR_THRESHOLD", uint256(1));
        cfg.timelockDelay = vm.envOr("TIMELOCK_DELAY", uint256(48 hours));
        // 復原等待期。正式環境 72 小時，寫在約定書裡；公開測試鏈上的展示要能在一次
        // 示範裡跑完，所以可以調短。調短是**部署決定**，不是合約後門——合約端不可改。
        cfg.recoveryDelay = vm.envOr("RECOVERY_DELAY", uint256(72 hours));

        _requireNoWellKnownKeys();
        _requireFundedDeployer();
    }

    /// @dev Anvil 的那十把金鑰**印在 anvil 的啟動畫面上**，全世界都有。
    ///      在本機那是便利，在任何一條別人也連得到的鏈上那是把鑰匙插在門上：
    ///      拿 operator 那把可以凍結所有人的錢包，拿 identityVerifier 那把可以
    ///      替自己簽發身分，拿國家 Safe 的持有人金鑰可以升級合約、撤換營運方。
    ///
    ///      所以換到公開鏈的第一道閘門在這裡，而且是**部署時**擋，不是上線後才發現：
    ///      一條用預設金鑰部署出去的鏈，補救方式只有整條重來。
    function _requireNoWellKnownKeys() internal view {
        if (_isLocalDevChain()) return;

        _rejectWellKnown("DEPLOYER_PK", cfg.deployer);
        _rejectWellKnown("SOVEREIGN", cfg.sovereign);
        _rejectWellKnown("OPERATOR", cfg.operator);
        _rejectWellKnown("TREASURY", cfg.treasury);
        _rejectWellKnown("IDENTITY_VERIFIER", cfg.identityVerifier);
        _rejectWellKnown("CARBON_VERIFIER", cfg.carbonVerifier);
        _rejectWellKnown("DOCUMENT_SIGNER", cfg.documentSigner);
        for (uint256 i = 0; i < cfg.nationalOwners.length; i++) _rejectWellKnown("NATIONAL_OWNERS", cfg.nationalOwners[i]);
        for (uint256 i = 0; i < cfg.operatorOwners.length; i++) _rejectWellKnown("OPERATOR_OWNERS", cfg.operatorOwners[i]);
    }

    function _rejectWellKnown(string memory role, address who) internal view {
        if (!_isAnvilAccount(who)) return;
        console2.log("");
        console2.log(unicode"這條鏈不是本機測試鏈，但有一個角色還用著 Anvil 的預設帳戶。");
        console2.log(unicode"  角色    ", role);
        console2.log(unicode"  地址    ", who);
        console2.log(unicode"  chainId ", block.chainid);
        console2.log("");
        console2.log(unicode"那些金鑰印在 anvil 的啟動畫面上，任何人都有。用它部署等於把治理權公開送出去。");
        console2.log(unicode"請在 .env 設一組這條鏈專用的金鑰與地址，見 README「部署到公開測試鏈」。");
        console2.log("");
        revert PublicKeyOnPublicChain(role, who, block.chainid);
    }

    /// @dev Anvil 預設助記詞（test test … junk）的前十個帳戶。
    function _isAnvilAccount(address a) internal pure returns (bool) {
        return a == 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 || a == 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
            || a == 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC || a == 0x90F79bf6EB2c4f870365E785982E1f101E93b906
            || a == 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 || a == 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
            || a == 0x976EA74026E726554dB657fA54763abd0C3a0aa9 || a == 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955
            || a == 0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f || a == 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;
    }

    /// @dev 只有這兩個 chainId 算「這台機器自己的鏈」。其餘一律當公開鏈處理——
    ///      判斷寫成白名單而不是黑名單：漏掉一條公開鏈的代價是金鑰外洩，
    ///      漏掉一條本機鏈的代價只是要多設一個環境變數。
    function _isLocalDevChain() internal view returns (bool) {
        return block.chainid == 31337 || block.chainid == 1337;
    }

    /// @dev 部署者沒錢時立刻擋下來，而不是讓 forge 先跑完整個模擬、印完所有地址，
    ///      最後才在廣播階段丟出 "Insufficient funds for gas * price + value"。
    ///
    ///      最常見的成因：`.env` 裡留著為另一條鏈設定的 DEPLOYER_PK。forge 會自動載入
    ///      專案根目錄的 `.env`，所以那把金鑰會無聲地蓋掉 Anvil 預設帳戶。
    function _requireFundedDeployer() internal view {
        if (cfg.deployer.balance > 0) return;
        console2.log("");
        console2.log(unicode"部署者餘額為 0，交易送不出去。");
        console2.log(unicode"  部署者地址 ", cfg.deployer);
        console2.log(unicode"  這條鏈 chainId", block.chainid);
        console2.log("");
        if (cfg.deployer != vm.addr(ANVIL_PK0)) {
            console2.log(unicode"這不是 Anvil 的預設帳戶，代表 DEPLOYER_PK 被環境變數或專案根目錄的 .env 指定了。");
            console2.log(unicode"  要用 Anvil 預設帳戶：把 .env 裡的 DEPLOYER_PK 註解掉（或 unset DEPLOYER_PK）");
            console2.log(unicode"  要繼續用這把金鑰：先撥款給它，例如");
            console2.log(unicode"    cast rpc anvil_setBalance <上面的地址> 0x3635c9adc5dea00000 --rpc-url anvil");
        } else {
            console2.log(unicode"Anvil 預設帳戶也沒錢 —— 這條鏈大概不是 Anvil，請設定一把有餘額的 DEPLOYER_PK。");
        }
        console2.log("");
        revert DeployerHasNoFunds(cfg.deployer, block.chainid);
    }

    /// @dev 治理基礎設施：Safe v1.4.1 + 兩個多簽 + 國家單位 Timelock。
    function _deployGovernance() internal {
        vm.startBroadcast(cfg.pk);
        if (cfg.nationalSafe == address(0) || cfg.operatorSafe == address(0)) {
            safeInfra = GovernanceLib.deploySafeInfra();
        }
        nationalSafe = cfg.nationalSafe != address(0)
            ? Safe(payable(cfg.nationalSafe))
            : GovernanceLib.createSafe(safeInfra, cfg.nationalOwners, cfg.nationalThreshold, 1);
        operatorSafe = cfg.operatorSafe != address(0)
            ? Safe(payable(cfg.operatorSafe))
            : GovernanceLib.createSafe(safeInfra, cfg.operatorOwners, cfg.operatorThreshold, 2);
        timelock = GovernanceLib.deployTimelock(cfg.timelockDelay, address(nationalSafe));
        vm.stopBroadcast();
    }

    function _deployCore() internal {
        vm.startBroadcast(cfg.pk);

        // ── 身分層 ──
        kyc = KYCRegistry(
            address(
                new ERC1967Proxy(
                    address(new KYCRegistry()),
                    abi.encodeCall(KYCRegistry.initialize, (cfg.sovereign, cfg.sovereign, cfg.operator))
                )
            )
        );

        // ── 登錄層（不可升級）──
        cert = new RetirementCertificate(cfg.sovereign, cfg.sovereign, cfg.operator);
        credit =
            new CarbonCredit1155(cfg.sovereign, cfg.sovereign, kyc, cert, "https://co2exchange.example/credit/{id}");
        registry = new CarbonRegistry(cfg.sovereign, cfg.sovereign, kyc, credit);
        reserve = new ReserveAttestation(cfg.sovereign, cfg.sovereign, cfg.operator);

        // ── 市場層（UUPS）──
        twd = new MockTWD(cfg.operator);
        // 各國費率表：預設交易 1%、註銷手續費 0（Phase 0 不收，數字由管理後台設定）
        feeSchedule = new FeeSchedule(cfg.sovereign, cfg.sovereign, cfg.operator, twd, cfg.treasury, 100, 0);
        listing = Listing(
            address(
                new ERC1967Proxy(
                    address(new Listing()),
                    abi.encodeCall(
                        Listing.initialize,
                        (cfg.sovereign, cfg.sovereign, cfg.operator, kyc, credit, twd, cfg.treasury, 100)
                    )
                )
            )
        );
        cct = CarbonCreditToken(
            address(
                new ERC1967Proxy(
                    address(new CarbonCreditToken()),
                    abi.encodeCall(
                        CarbonCreditToken.initialize,
                        (
                            cfg.sovereign,
                            kyc,
                            cfg.vintage,
                            string.concat("Carbon Credit Token ", vm.toString(uint256(cfg.vintage))),
                            "CCT"
                        )
                    )
                )
            )
        );
        pool = CarbonPool(
            address(
                new ERC1967Proxy(
                    address(new CarbonPool()),
                    abi.encodeCall(
                        CarbonPool.initialize,
                        (cfg.sovereign, cfg.sovereign, cfg.operator, kyc, credit, cct, cfg.vintage, 500, cfg.treasury)
                    )
                )
            )
        );
        vm.stopBroadcast();
    }

    /// @dev 帳戶層，與 v4 無關 —— 不含 v4 的核心部署一樣要有。
    ///
    ///      兩個角色在這裡固定下來，之後所有使用者錢包共用：
    ///      · recoveryAgent = 國家級 Safe。只有它能**提案**復原（使用者所有裝置都遺失時），
    ///        而且提案要等 72 小時、期間任何一把現存 passkey 都能否決。它不能直接動錢。
    ///      · operator = 平台 relayer。唯一的特權是**凍結**，讓只通過登入、手上已經沒有
    ///        passkey 的人也止得了血。它不能解凍——解凍要一把現存 passkey 或治理方。
    ///      這個不對稱是刻意的：往安全的方向動門檻低，往開鎖的方向動門檻高。
    function _deployAccountFactory() internal {
        vm.startBroadcast(cfg.pk);
        accountFactory = new PasskeyAccountFactory(address(nationalSafe), cfg.operator, cfg.recoveryDelay);

        // Bank：使用者在交易所期間的資產池。內部買賣是帳本更新，每個 epoch 把餘額樹
        // root 提交上鏈。提領預設關閉（Phase 0 不提供），但機制完整且測過。
        bank = new Bank(address(credit), address(twd), address(nationalSafe), cfg.operator);
        vm.stopBroadcast();

        // Bank 要登錄成系統合約——存入那一筆 transfer 走 CarbonCredit1155._update，
        // 沒有身分就進不來。用 SystemContract（和 Listing、CarbonPool 同一類）而不是
        // 簽一張 KYC attestation 給它：Bank 不是一個「通過身分驗證的法人」，
        // 它是平台基礎設施，而這兩件事在登錄簿上的意義完全不同。
        // 這一步在 _wireAsSovereign 裡做（需要主權角色）。
    }

    /// @dev v4 展示模組的掛載點。核心部署不含 v4（這樣才能在沒有 EIP-1153 的鏈上編譯與執行）；
    ///      DeployV4 會覆寫這個函式。見 script/DeployV4.s.sol。
    function _deployV4() internal virtual {}

    /// @dev Phase 0 預設 deployer == sovereign == operator。正式環境這些由 Safe 交易執行。
    function _wireAsSovereign() internal {
        require(cfg.deployer == cfg.sovereign, "Phase 0 script expects deployer == sovereign");
        vm.startBroadcast(cfg.pk);
        credit.setRegistry(address(registry));
        cert.grantRole(cert.MINTER_ROLE(), address(credit));
        cert.grantRole(cert.DOCUMENT_ROLE(), cfg.documentSigner);
        cct.grantRole(cct.POOL_ROLE(), address(pool));
        kyc.grantRole(kyc.IDENTITY_VERIFIER_ROLE(), cfg.identityVerifier);
        registry.approveVerifier(cfg.carbonVerifier);
        // 費率：管理後台用的調價金鑰，以及讓額度合約有權向使用者收註銷手續費
        feeSchedule.grantRole(feeSchedule.PRICING_ROLE(), cfg.documentSigner);
        feeSchedule.grantRole(feeSchedule.COLLECTOR_ROLE(), address(credit));
        credit.setFeeSchedule(address(feeSchedule));
        listing.setFeeSchedule(feeSchedule);
        // 託管揭露：營運端的報表服務金鑰負責每月 5 日發布，查核機構金鑰負責簽署定稿。
        // 兩把鑰匙分開，否則「自己填、自己查」的揭露沒有意義。
        reserve.grantRole(reserve.REPORTER_ROLE(), cfg.documentSigner);
        reserve.grantRole(reserve.AUDITOR_ROLE(), cfg.carbonVerifier);
        _seedJurisdictions();
        _seedImportedProjects();
        kyc.addRecoverableToken(address(credit));
        kyc.addRecoverableToken(address(cct));
        kyc.setSystemContract(address(listing), true);
        kyc.setSystemContract(address(bank), true);
        kyc.setSystemContract(address(pool), true);
        if (poolManager != address(0)) kyc.setSystemContract(poolManager, true);
        vm.stopBroadcast();
    }


    /// @dev 開放的轄區。每一個都對得到那個國家真正存在的機制與登錄簿——
    ///      不編造國家，也不把「交易平台」當成「國家級登錄簿」（例如香港 Core Climate 是平台，不是登錄簿）。
    ///
    ///      國外額度的 purposeMask 一律只有 CarbonFee | VoluntaryNeutrality（0x03）：
    ///      氣候變遷因應法第 27 條把國外減量額度限縮到扣除碳費排放量與抵銷超額量，
    ///      增量抵換（第 24 條）與環評承諾事項都只認國內額度。
    ///      跨境使用規定尚未訂定的轄區（中國、印度）則 enabled = false：
    ///      可以被看見、被說明，但不能上架——這不是技術限制，是那些國家還沒開門。
    function _seedJurisdictions() internal {
        uint8 FOREIGN = 0x03; // CarbonFee | VoluntaryNeutrality

        registry.setJurisdiction("JP", IJurisdictions.Jurisdiction({
            enabled: true, domestic: false, purposeMask: FOREIGN,
            name: unicode"日本", scheme: "J-Credit",
            registryName: unicode"Ｊ－クレジット登録簿",
            note: unicode"經濟產業省、環境省、農林水產省三省共管；另有 JCM 二國間信用制度（巴黎協定第 6.2 條）"
        }));
        registry.setJurisdiction("KR", IJurisdictions.Jurisdiction({
            enabled: true, domestic: false, purposeMask: FOREIGN,
            name: unicode"韓國", scheme: "KOC",
            registryName: unicode"溫室氣體綜合資訊中心（GIR）抵換登錄系統",
            note: unicode"K-ETS 抵換上限為應繳配額 10%；未結轉者於發行年度結束後 8 個月失效"
        }));
        registry.setJurisdiction("TH", IJurisdictions.Jurisdiction({
            enabled: true, domestic: false, purposeMask: FOREIGN,
            name: unicode"泰國", scheme: "T-VER",
            registryName: unicode"TGO T-VER Registry",
            note: unicode"泰國溫室氣體管理組織（TGO）核發，分 Standard 與 Premium 兩軌；已與新加坡簽第 6 條實施協定"
        }));
        registry.setJurisdiction("ID", IJurisdictions.Jurisdiction({
            enabled: true, domestic: false, purposeMask: FOREIGN,
            name: unicode"印尼", scheme: "SPE-GRK",
            registryName: "SRN PPI",
            note: unicode"國家登錄簿 SRN PPI 與 IDXCarbon 交易所連線；法源已由 Perpres 110/2025 取代 98/2021"
        }));
        registry.setJurisdiction("AU", IJurisdictions.Jurisdiction({
            enabled: true, domestic: false, purposeMask: FOREIGN,
            name: unicode"澳洲", scheme: "ACCU",
            registryName: "ANREU",
            note: unicode"Clean Energy Regulator 核發，登錄簿 ANREU 已遷至 Unit and Certificate Registry；自然人亦可開戶"
        }));
        registry.setJurisdiction("CN", IJurisdictions.Jurisdiction({
            enabled: false, domestic: false, purposeMask: FOREIGN,
            name: unicode"中國", scheme: "CCER",
            registryName: unicode"全國溫室氣體自願減排註冊登記系統",
            note: unicode"生態環境部部令第 31 號；辦法第 29 條明定跨境交易與使用之規定「另行制定」，尚未開放，故本站暫不開放上架"
        }));
        registry.setJurisdiction("IN", IJurisdictions.Jurisdiction({
            enabled: false, domestic: false, purposeMask: FOREIGN,
            name: unicode"印度", scheme: "CCC",
            registryName: "Indian Carbon Market Registry",
            note: unicode"CCTS 2023（BEE 主管）；國際移轉須經 National Steering Committee 指引與中央政府核准，尚未開放"
        }));
        registry.setJurisdiction("SG", IJurisdictions.Jurisdiction({
            enabled: false, domestic: false, purposeMask: 0,
            name: unicode"新加坡", scheme: "ICC",
            registryName: unicode"（無自建登錄簿，於 CCP 登錄簿退役）",
            note: unicode"新加坡不核發國家級額度，其國際碳權制度是買方端：抵碳稅上限 5%、須符合巴黎協定第 6 條並由地主國作相應調整"
        }));
    }

    /// @dev 國外額度的專案登錄需要主權角色，而主權角色在 _handover 之後就不在部署者手上了。
    ///      所以要在這個時點掛進來。核心部署不引入任何國外額度，demo 腳本才覆寫。
    function _seedImportedProjects() internal virtual {}

    /// @dev 目前 OPERATOR 的佈線只有 v4 hook，核心部署沒有東西要做。
    function _wireAsOperator() internal virtual {}

    /// @dev 建池由 DeployV4 覆寫（需要 v4 型別）。
    function _initPool() internal virtual {}

    /// @dev 移轉：DEFAULT_ADMIN（升級、角色結構）→ Timelock；SOVEREIGN（緊急權）→ 國家 Safe；OPERATOR → 營運 Safe；
    ///      部署者 renounce 全部治理角色。保留的服務角色：身分驗證服務簽章、查驗機構簽章、MockTWD 鑄幣（demo faucet）。
    function _handover() internal {
        bytes32 ADMIN = 0x00;
        bytes32 SOV = keccak256("SOVEREIGN_ROLE");
        bytes32 OP = keccak256("OPERATOR_ROLE");
        address[7] memory withOperator =
            [address(kyc), address(cert), address(listing), address(pool), hook, address(reserve), address(feeSchedule)];
        address[2] memory sovereignOnly = [address(credit), address(registry)];

        vm.startBroadcast(cfg.pk);
        for (uint256 i = 0; i < withOperator.length; i++) {
            address c = withOperator[i];
            if (c == address(0)) continue;
            IAccessControl(c).grantRole(SOV, address(nationalSafe));
            IAccessControl(c).grantRole(OP, address(operatorSafe));
            IAccessControl(c).grantRole(ADMIN, address(timelock));
            IAccessControl(c).renounceRole(OP, cfg.deployer);
            IAccessControl(c).renounceRole(SOV, cfg.deployer);
            IAccessControl(c).renounceRole(ADMIN, cfg.deployer);
        }
        for (uint256 i = 0; i < sovereignOnly.length; i++) {
            address c = sovereignOnly[i];
            IAccessControl(c).grantRole(SOV, address(nationalSafe));
            IAccessControl(c).grantRole(ADMIN, address(timelock));
            IAccessControl(c).renounceRole(SOV, cfg.deployer);
            IAccessControl(c).renounceRole(ADMIN, cfg.deployer);
        }
        // CCT：只有 DEFAULT_ADMIN（升級）
        cct.grantRole(ADMIN, address(timelock));
        cct.renounceRole(ADMIN, cfg.deployer);
        // MockTWD：管理權給營運 Safe，鑄幣權保留給 deployer 供 demo faucet
        twd.grantRole(ADMIN, address(operatorSafe));
        twd.renounceRole(ADMIN, cfg.deployer);
        vm.stopBroadcast();
    }

    function _print() internal view {
        console2.log("KYCRegistry          ", address(kyc));
        console2.log("RetirementCertificate", address(cert));
        console2.log("CarbonCredit1155     ", address(credit));
        console2.log("CarbonRegistry       ", address(registry));
        console2.log("MockTWD              ", address(twd));
        console2.log("Listing              ", address(listing));
        console2.log("CarbonCreditToken    ", address(cct));
        console2.log("CarbonPool           ", address(pool));
        console2.log("PoolManager          ", poolManager);
        console2.log("CarbonKYCHook        ", hook);
        console2.log("TrustedRouter        ", router);
        console2.log("PasskeyAccountFactory", address(accountFactory));
        console2.log("NationalSafe         ", address(nationalSafe));
        console2.log("OperatorSafe         ", address(operatorSafe));
        console2.log("Timelock             ", address(timelock));
    }

    /// @dev 前端讀 deployments/<chainId>.json
    ///
    /// deployedAt 是「這一次部署」的識別碼（主機時鐘毫秒，非鏈上時間）。
    /// 少了它，Anvil 重開再部署會產生**一模一樣的地址**（同一個部署者、同樣的 nonce 順序），
    /// 前端就分不出「還是同一條鏈」與「鏈重開了、鏈上狀態全沒了」——
    /// web/data/ 裡那些寫著「已核准」的紀錄會繼續被當成有效，但鏈上查無此身分。
    function _writeDeployment() internal {
        string memory j = "d";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "deployedAt", vm.unixTime());
        vm.serializeUint(j, "deployedAtBlock", block.number);
        vm.serializeAddress(j, "kycRegistry", address(kyc));
        vm.serializeAddress(j, "retirementCertificate", address(cert));
        vm.serializeAddress(j, "carbonCredit1155", address(credit));
        vm.serializeAddress(j, "carbonRegistry", address(registry));
        vm.serializeAddress(j, "reserveAttestation", address(reserve));
        vm.serializeAddress(j, "feeSchedule", address(feeSchedule));
        vm.serializeAddress(j, "settlementToken", address(twd));
        vm.serializeAddress(j, "listing", address(listing));
        vm.serializeAddress(j, "cct", address(cct));
        vm.serializeAddress(j, "carbonPool", address(pool));
        vm.serializeAddress(j, "poolManager", poolManager);
        vm.serializeAddress(j, "hook", hook);
        vm.serializeAddress(j, "router", router);
        vm.serializeUint(j, "poolFee", 3000);
        vm.serializeUint(j, "tickSpacing", 60);
        vm.serializeAddress(j, "accountFactory", address(accountFactory));
        vm.serializeAddress(j, "bank", address(bank));
        vm.serializeAddress(j, "nationalSafe", address(nationalSafe));
        vm.serializeAddress(j, "operatorSafe", address(operatorSafe));
        vm.serializeUint(j, "timelockDelay", cfg.timelockDelay);
        string memory out = vm.serializeAddress(j, "timelock", address(timelock));
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
