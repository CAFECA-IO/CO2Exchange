// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Safe} from "safe-smart-account/Safe.sol";
import {Ledger} from "../src/ledger/Ledger.sol";
import {GovernanceLib} from "../src/governance/GovernanceLib.sol";
import {MockTWD} from "../src/mocks/MockTWD.sol";

/// @title DeployLedger — 設計 v4 的部署：鏈上只剩帳本合約與治理
///
/// 部署的東西只有：
///   · 治理：國家 Safe（2-of-3）、營運 Safe（1-of-2）、Timelock（國家 Safe 提案與執行）
///   · `Ledger`：承諾鏈、授權金鑰清單、結算幣託管、碳權請求權登記
///   · MockTWD（只在沒有指定 SETTLEMENT_TOKEN 時）
///
/// 登錄簿、身分、市場、憑證、對帳報告**都不再有合約**——它們是鏈下帳本裡的事件，
/// 每小時以四個 root 承諾上鏈（見 web/lib/ledger/）。
///
/// 流程：部署者先暫時持有主權與營運角色 → 授予帳本授權金鑰與承諾提交者 → 把角色移交給
/// Safe 與 Timelock → 部署者放棄全部角色。部署完成之後，部署者對這份合約沒有任何權限。
///
/// 環境變數（皆為地址，私鑰只有 DEPLOYER_PK）：
///   SETTLEMENT_TOKEN   外部結算幣（Boltchain：CAFECA 的 TWDC）。沒給就部署 MockTWD
///   NATIONAL_OWNERS / NATIONAL_THRESHOLD / OPERATOR_OWNERS / OPERATOR_THRESHOLD / TIMELOCK_DELAY
///   COMMITTER          每小時提交承諾的服務金鑰（預設 = relayer）
///   IDENTITY_VERIFIER / CARBON_VERIFIER / DOCUMENT_SIGNER / AUDITOR / RECEIPT_SIGNER
///   SOVEREIGN_SIGNER / OPERATOR_SIGNER   可選：除了 Safe 之外，另外授權一把 EOA 代簽主權／營運事件
///                                        （例如本機展示）。授權是鏈上公開的，任何人都看得到
contract DeployLedger is Script {
    uint256 internal constant ANVIL_PK0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    error PublicKeyOnPublicChain(string role, address who, uint256 chainId);

    struct Config {
        uint256 pk;
        address deployer;
        address settlementToken;
        address[] nationalOwners;
        uint256 nationalThreshold;
        address[] operatorOwners;
        uint256 operatorThreshold;
        uint256 timelockDelay;
        address committer;
        address identityVerifier;
        address carbonVerifier;
        address documentSigner;
        address auditor;
        address receiptSigner;
        address sovereignSigner;
        address operatorSigner;
    }

    Config internal cfg;
    Safe public nationalSafe;
    Safe public operatorSafe;
    TimelockController public timelock;
    Ledger public ledger;
    IERC20 public settlement;
    bool public mintable;

    function run() external {
        _load();
        vm.startBroadcast(cfg.pk);
        GovernanceLib.SafeInfra memory infra = GovernanceLib.deploySafeInfra();
        nationalSafe = GovernanceLib.createSafe(infra, cfg.nationalOwners, cfg.nationalThreshold, 1);
        operatorSafe = GovernanceLib.createSafe(infra, cfg.operatorOwners, cfg.operatorThreshold, 2);
        timelock = GovernanceLib.deployTimelock(cfg.timelockDelay, address(nationalSafe));

        if (cfg.settlementToken == address(0)) {
            MockTWD twd = new MockTWD(cfg.deployer);
            settlement = IERC20(address(twd));
            mintable = true;
        } else {
            require(cfg.settlementToken.code.length > 0, "SETTLEMENT_TOKEN has no code");
            settlement = IERC20(cfg.settlementToken);
        }

        // 部署者暫時持有三個治理角色，佈線完就放掉
        ledger = new Ledger(address(settlement), cfg.deployer, cfg.deployer, cfg.deployer);
        _authorities();
        ledger.grantRole(ledger.COMMITTER_ROLE(), cfg.committer);
        _handover();
        vm.stopBroadcast();

        _print();
        _write();
    }

    function _authorities() internal {
        ledger.grantAuthority(ledger.AUTH_SOVEREIGN(), address(nationalSafe));
        ledger.grantAuthority(ledger.AUTH_OPERATOR(), address(operatorSafe));
        ledger.grantAuthority(ledger.AUTH_IDENTITY_VERIFIER(), cfg.identityVerifier);
        ledger.grantAuthority(ledger.AUTH_CARBON_VERIFIER(), cfg.carbonVerifier);
        ledger.grantAuthority(ledger.AUTH_DOCUMENT_SIGNER(), cfg.documentSigner);
        ledger.grantAuthority(ledger.AUTH_AUDITOR(), cfg.auditor);
        ledger.grantAuthority(ledger.AUTH_RECEIPT_SIGNER(), cfg.receiptSigner);
        if (cfg.sovereignSigner != address(0)) ledger.grantAuthority(ledger.AUTH_SOVEREIGN(), cfg.sovereignSigner);
        if (cfg.operatorSigner != address(0)) ledger.grantAuthority(ledger.AUTH_OPERATOR(), cfg.operatorSigner);
    }

    function _handover() internal {
        bytes32 ADMIN = ledger.DEFAULT_ADMIN_ROLE();
        bytes32 SOV = ledger.SOVEREIGN_ROLE();
        bytes32 OP = ledger.OPERATOR_ROLE();
        ledger.grantRole(SOV, address(nationalSafe));
        ledger.grantRole(OP, address(operatorSafe));
        ledger.grantRole(ADMIN, address(timelock));
        ledger.renounceRole(OP, cfg.deployer);
        ledger.renounceRole(SOV, cfg.deployer);
        ledger.renounceRole(ADMIN, cfg.deployer);
        if (mintable) {
            // MockTWD 的管理權給營運 Safe；鑄幣權留給部署者（本機展示的入金）
            MockTWD(address(settlement)).grantRole(ADMIN, address(operatorSafe));
            MockTWD(address(settlement)).renounceRole(ADMIN, cfg.deployer);
        }
    }

    function _load() internal {
        cfg.pk = vm.envOr("DEPLOYER_PK", ANVIL_PK0);
        cfg.deployer = vm.addr(cfg.pk);
        cfg.settlementToken = vm.envOr("SETTLEMENT_TOKEN", address(0));
        address[] memory nat = new address[](3);
        nat[0] = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc;
        nat[1] = 0x976EA74026E726554dB657fA54763abd0C3a0aa9;
        nat[2] = 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955;
        address[] memory op = new address[](2);
        op[0] = 0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f;
        op[1] = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;
        cfg.nationalOwners = vm.envOr("NATIONAL_OWNERS", ",", nat);
        cfg.nationalThreshold = vm.envOr("NATIONAL_THRESHOLD", uint256(2));
        cfg.operatorOwners = vm.envOr("OPERATOR_OWNERS", ",", op);
        cfg.operatorThreshold = vm.envOr("OPERATOR_THRESHOLD", uint256(1));
        cfg.timelockDelay = vm.envOr("TIMELOCK_DELAY", uint256(48 hours));
        cfg.committer = vm.envOr("COMMITTER", cfg.deployer);
        cfg.identityVerifier = vm.envOr("IDENTITY_VERIFIER", cfg.deployer);
        cfg.carbonVerifier = vm.envOr("CARBON_VERIFIER", cfg.deployer);
        cfg.documentSigner = vm.envOr("DOCUMENT_SIGNER", cfg.deployer);
        cfg.auditor = vm.envOr("AUDITOR", cfg.carbonVerifier);
        cfg.receiptSigner = vm.envOr("RECEIPT_SIGNER", cfg.committer);
        cfg.sovereignSigner = vm.envOr("SOVEREIGN_SIGNER", address(0));
        cfg.operatorSigner = vm.envOr("OPERATOR_SIGNER", address(0));

        if (block.chainid == 31337 || block.chainid == 1337) return;
        // 公開鏈上不准用 anvil 的公開金鑰擔任任何角色——那些私鑰印在 anvil 的啟動畫面上
        _reject("DEPLOYER_PK", cfg.deployer);
        _reject("COMMITTER", cfg.committer);
        _reject("IDENTITY_VERIFIER", cfg.identityVerifier);
        _reject("CARBON_VERIFIER", cfg.carbonVerifier);
        _reject("DOCUMENT_SIGNER", cfg.documentSigner);
        _reject("AUDITOR", cfg.auditor);
        _reject("RECEIPT_SIGNER", cfg.receiptSigner);
        _reject("SOVEREIGN_SIGNER", cfg.sovereignSigner);
        _reject("OPERATOR_SIGNER", cfg.operatorSigner);
        for (uint256 i = 0; i < cfg.nationalOwners.length; i++) _reject("NATIONAL_OWNERS", cfg.nationalOwners[i]);
        for (uint256 i = 0; i < cfg.operatorOwners.length; i++) _reject("OPERATOR_OWNERS", cfg.operatorOwners[i]);
    }

    function _reject(string memory role, address who) internal view {
        bool anvil = who == 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 || who == 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
            || who == 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC || who == 0x90F79bf6EB2c4f870365E785982E1f101E93b906
            || who == 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 || who == 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
            || who == 0x976EA74026E726554dB657fA54763abd0C3a0aa9 || who == 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955
            || who == 0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f || who == 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;
        if (anvil) revert PublicKeyOnPublicChain(role, who, block.chainid);
    }

    function _print() internal view {
        console2.log("Ledger            ", address(ledger));
        console2.log("Settlement token  ", address(settlement));
        console2.log("NationalSafe      ", address(nationalSafe));
        console2.log("OperatorSafe      ", address(operatorSafe));
        console2.log("Timelock          ", address(timelock));
        console2.log("Committer         ", cfg.committer);
    }

    /// @dev deployments/<chainId>.json。`ledgerVersion` 讓網站與腳本分辨這是 v4 部署。
    function _write() internal {
        string memory j = "d";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "ledgerVersion", 2);
        vm.serializeUint(j, "deployedAt", vm.unixTime());
        vm.serializeUint(j, "deployedAtBlock", block.number);
        vm.serializeAddress(j, "ledger", address(ledger));
        vm.serializeAddress(j, "settlementToken", address(settlement));
        vm.serializeBool(j, "settlementMintable", mintable);
        vm.serializeAddress(j, "committer", cfg.committer);
        vm.serializeAddress(j, "nationalSafe", address(nationalSafe));
        vm.serializeAddress(j, "operatorSafe", address(operatorSafe));
        vm.serializeUint(j, "timelockDelay", cfg.timelockDelay);
        string memory out = vm.serializeAddress(j, "timelock", address(timelock));
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
