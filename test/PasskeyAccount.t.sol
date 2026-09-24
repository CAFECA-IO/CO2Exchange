// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IKYCRegistry} from "../src/interfaces/IKYCRegistry.sol";
import {WebAuthn} from "../src/account/WebAuthn.sol";
import {PasskeyAccount} from "../src/account/PasskeyAccount.sol";
import {PasskeyAccountFactory} from "../src/account/PasskeyAccountFactory.sol";
import {Listing} from "../src/market/Listing.sol";
import {CarbonCredit1155} from "../src/registry/CarbonCredit1155.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice 用 forge 的 P-256 cheatcode 組出完整 WebAuthn 斷言，驗證錢包的三件事：
///         一、平常怎麼用（relayer 代送的購買與註銷）；
///         二、多裝置怎麼管（加一把、撤一把、不准撤到零把）；
///         三、四種事故怎麼救（裝置遺失、全部遺失、登入被盜、passkey 被盜）。
///
/// 事故那一組是這個檔案的重點。它們檢查的與其說是功能，不如說是**權限的邊界**：
/// 誰能凍結、誰能解凍、誰能提案復原、誰能否決——以及同樣重要的，誰**不能**。
contract PasskeyAccountTest is Fixture {
    uint256 constant P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;

    // 三把 passkey，代表三台裝置
    uint256 internal phonePk = 0x5EED; // 手機（初始金鑰）
    uint256 internal laptopPk = 0x1A970; // 筆電
    uint256 internal newPk = 0xC0FFEE; // 復原時配的新裝置

    bytes32 internal qx;
    bytes32 internal qy;
    bytes32 internal phoneKeyId;

    PasskeyAccountFactory internal factory;
    PasskeyAccount internal account;

    address internal relayer = makeAddr("relayer");
    address internal recoveryAgent = makeAddr("recoveryAgent"); // 治理 Safe
    bytes32 internal constant ACCOUNT_REF = keccak256("google:luphia@example.com");
    /// 等待期現在是部署參數（見 PasskeyAccountFactory）。測試用正式環境的值，
    /// 因為這些測試驗的是「等待期真的擋得住」，不是某條鏈上剛好設了多久。
    uint256 internal constant RECOVERY_DELAY = 72 hours;

    uint256 internal batch;

    function setUp() public override {
        super.setUp();
        (qx, qy) = _pub(phonePk);
        phoneKeyId = keccak256(abi.encode(qx, qy));

        // recoveryAgent = 治理 Safe；operator = 平台 relayer（只能凍結）
        factory = new PasskeyAccountFactory(recoveryAgent, operator, RECOVERY_DELAY);

        // 地址在部署之前就算得出來，而且只由登入帳號決定——不需要知道任何金鑰
        address predicted = factory.getAddress(ACCOUNT_REF);
        vm.prank(relayer);
        account = factory.createAccount(ACCOUNT_REF, qx, qy, unicode"Luphia 的 iPhone");
        assertEq(address(account), predicted);

        // 身分綁在帳戶地址。這個測試要走到註銷，所以給法人身分——自然人不能註銷。
        _registerIdentity(address(account), IKYCRegistry.Tier.Corporate, keccak256("TW-ID-B222"));
        vm.prank(operator);
        twd.mint(address(account), 100_000e6);

        uint256 pid = _registerProject(companyA);
        batch = _issue(pid, 10_000, keccak256("PK1"));
        vm.startPrank(companyA);
        credit.setApprovalForAll(address(listing), true);
        listing.list(batch, 10_000, 800e6, 0);
        vm.stopPrank();
    }

    // ───────────────────────── 地址與身分 ─────────────────────────

    /// 地址由登入帳號決定，不由金鑰決定：這是「換裝置還是同一個錢包」的地基。
    /// 拿另一把 passkey 去「建立」同一個登入帳號，得到的是同一個錢包，
    /// 而且**不會**把金鑰換掉——否則任何人送一把公鑰進來就能替別人換鎖。
    function test_createAccount_isIdempotentAndDoesNotRekey() public {
        (bytes32 ox, bytes32 oy) = _pub(laptopPk);
        vm.prank(stranger);
        PasskeyAccount again = factory.createAccount(ACCOUNT_REF, ox, oy, unicode"攻擊者的裝置");
        assertEq(address(again), address(account));
        assertEq(account.activeKeys(), 1);
        assertFalse(account.keyOf(keccak256(abi.encode(ox, oy))).active);
    }

    function test_differentAccountRef_differentWallet() public view {
        assertTrue(factory.getAddress(keccak256("google:other@example.com")) != address(account));
    }

    // ───────────────────────── 平常怎麼用 ─────────────────────────

    function test_execute_buyThenRetire_viaRelayer() public {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](2);
        calls[0] = PasskeyAccount.Call(address(twd), 0, abi.encodeCall(IERC20.approve, (address(listing), 2_000e6)));
        calls[1] = PasskeyAccount.Call(address(listing), 0, abi.encodeCall(Listing.buy, (1, 2_000)));

        vm.prank(relayer);
        account.execute(calls, phoneKeyId, _sign(phonePk, account.getDigest(calls, account.nonce())));
        assertEq(credit.balanceOf(address(account), batch), 2_000);
        assertEq(account.nonce(), 1);

        PasskeyAccount.Call[] memory retireCalls = new PasskeyAccount.Call[](1);
        retireCalls[0] = PasskeyAccount.Call(
            address(credit),
            0,
            abi.encodeCall(CarbonCredit1155.retire, (_retireReq(address(account), batch, 2_000, address(account))))
        );
        vm.prank(relayer);
        account.execute(retireCalls, phoneKeyId, _sign(phonePk, account.getDigest(retireCalls, 1)));
        assertEq(cert.balanceOf(address(account)), 1);
        assertEq(credit.batchOf(batch).retiredKg, 2_000);
    }

    function test_execute_replayRejected() public {
        PasskeyAccount.Call[] memory calls = _approveCall(1);
        bytes memory sig = _sign(phonePk, account.getDigest(calls, 0));
        account.execute(calls, phoneKeyId, sig);
        vm.expectRevert(PasskeyAccount.InvalidSignature.selector);
        account.execute(calls, phoneKeyId, sig);
    }

    function test_execute_tamperedCallRejected() public {
        PasskeyAccount.Call[] memory calls = _approveCall(1);
        bytes memory sig = _sign(phonePk, account.getDigest(calls, 0));
        calls[0].data = abi.encodeCall(IERC20.approve, (address(listing), 2));
        vm.expectRevert(PasskeyAccount.InvalidSignature.selector);
        account.execute(calls, phoneKeyId, sig);
    }

    /// 不是這個錢包的金鑰簽的，就算 keyId 對得上也不行
    function test_execute_wrongKeyRejected() public {
        PasskeyAccount.Call[] memory calls = _approveCall(1);
        bytes memory sig = _sign(laptopPk, account.getDigest(calls, 0));
        vm.expectRevert(PasskeyAccount.InvalidSignature.selector);
        account.execute(calls, phoneKeyId, sig);
    }

    /// 已經撤掉的裝置，簽得再正確也進不來
    function test_execute_unknownKeyIdRejected() public {
        (bytes32 ox, bytes32 oy) = _pub(laptopPk);
        bytes32 unknown = keccak256(abi.encode(ox, oy));
        PasskeyAccount.Call[] memory calls = _approveCall(1);
        bytes memory sig = _sign(laptopPk, account.getDigest(calls, 0));
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.UnknownKey.selector, unknown));
        account.execute(calls, unknown, sig);
    }

    function test_execute_innerRevertBubbles() public {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(listing), 0, abi.encodeCall(Listing.buy, (1, 2_000))); // 沒 approve
        bytes memory sig = _sign(phonePk, account.getDigest(calls, 0));
        vm.expectRevert();
        account.execute(calls, phoneKeyId, sig);
    }

    // ───────────────────────── 多裝置 ─────────────────────────

    function test_addKey_secondDeviceCanSign() public {
        bytes32 laptopId = _addLaptop();
        assertEq(account.activeKeys(), 2);
        (bytes32[] memory ids,) = account.keys();
        assertEq(ids.length, 2);

        // 新裝置可以獨立動錢
        PasskeyAccount.Call[] memory calls = _approveCall(7);
        account.execute(calls, laptopId, _sign(laptopPk, account.getDigest(calls, account.nonce())));
        assertEq(twd.allowance(address(account), address(listing)), 7);
    }

    /// 事故一：手機掉了，用筆電把它撤掉。不需要平台、不需要治理方、即時生效。
    function test_removeKey_lostDevice() public {
        bytes32 laptopId = _addLaptop();
        _selfCall(laptopPk, laptopId, abi.encodeCall(PasskeyAccount.removeKey, (phoneKeyId)));

        assertEq(account.activeKeys(), 1);
        assertFalse(account.keyOf(phoneKeyId).active);

        PasskeyAccount.Call[] memory calls = _approveCall(1);
        bytes memory sig = _sign(phonePk, account.getDigest(calls, account.nonce()));
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.UnknownKey.selector, phoneKeyId));
        account.execute(calls, phoneKeyId, sig);
    }

    /// 最後一把撤不掉：那是一個按錯一次就無法挽回的按鈕，不該存在。
    function test_removeKey_lastKeyRejected() public {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(
            address(account), 0, abi.encodeCall(PasskeyAccount.removeKey, (phoneKeyId))
        );
        bytes memory sig = _sign(phonePk, account.getDigest(calls, account.nonce()));
        vm.expectRevert(
            abi.encodeWithSelector(
                PasskeyAccount.CallFailed.selector, 0, abi.encodeWithSelector(PasskeyAccount.LastKey.selector)
            )
        );
        account.executeSelf(calls, phoneKeyId, sig);
    }

    /// 外面的人不能直接改金鑰——連治理方都不行。金鑰管理只走帳戶自己。
    function test_keyManagement_requiresSelf() public {
        (bytes32 ox, bytes32 oy) = _pub(laptopPk);
        vm.expectRevert(PasskeyAccount.NotSelf.selector);
        account.addKey(ox, oy, unicode"偷渡");
        vm.prank(recoveryAgent);
        vm.expectRevert(PasskeyAccount.NotSelf.selector);
        account.addKey(ox, oy, unicode"治理方也不行");
        vm.prank(operator);
        vm.expectRevert(PasskeyAccount.NotSelf.selector);
        account.removeKey(phoneKeyId);
    }

    /// executeSelf 是唯一繞過凍結的入口，所以它只准做金鑰與凍結相關的事。
    function test_executeSelf_onlyWhitelistedSelectors() public {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(twd), 0, abi.encodeCall(IERC20.approve, (address(listing), 1)));
        bytes memory sig = _sign(phonePk, account.getDigest(calls, 0));
        vm.expectRevert(PasskeyAccount.NotSelf.selector);
        account.executeSelf(calls, phoneKeyId, sig);

        // 目標是自己、但不是白名單上的函式，一樣擋
        calls[0] = PasskeyAccount.Call(address(account), 0, abi.encodeCall(PasskeyAccount.finaliseRecovery, ()));
        sig = _sign(phonePk, account.getDigest(calls, 0));
        vm.expectRevert(PasskeyAccount.NotSelf.selector);
        account.executeSelf(calls, phoneKeyId, sig);
    }

    // ───────────────────────── 事故：凍結 ─────────────────────────

    /// 事故四：裝置被拿走且能解鎖，來不及撤金鑰——先凍結止血。
    function test_freeze_blocksExecuteButNotKeyManagement() public {
        vm.prank(operator);
        account.freeze();
        assertTrue(account.frozen());

        PasskeyAccount.Call[] memory calls = _approveCall(1);
        bytes memory sig = _sign(phonePk, account.getDigest(calls, 0));
        vm.expectRevert(PasskeyAccount.AccountFrozen.selector);
        account.execute(calls, phoneKeyId, sig);

        // 凍結中仍然能撤掉那把被偷的金鑰、能解凍——否則止血手段變成陷阱
        bytes32 laptopId = _addLaptopWhileFrozen();
        _selfCall(laptopPk, laptopId, abi.encodeCall(PasskeyAccount.removeKey, (phoneKeyId)));
        _selfCall(laptopPk, laptopId, abi.encodeCall(PasskeyAccount.unfreeze, ()));
        assertFalse(account.frozen());
    }

    /// 事故三：登入帳號被盜。盜用者能按下凍結（透過平台 relayer），
    /// 但解不開——解凍要一把現存 passkey 或治理方。所以他能造成的最大傷害是不方便。
    function test_freeze_lowBarUnfreezeHighBar() public {
        vm.prank(operator);
        account.freeze();

        // operator 不能解凍
        vm.prank(operator);
        vm.expectRevert(PasskeyAccount.NotSelf.selector);
        account.unfreeze();

        // 隨便一個人更不行
        vm.prank(stranger);
        vm.expectRevert(PasskeyAccount.NotSelf.selector);
        account.freeze();

        // 持有人自己解得開
        _selfCall(phonePk, phoneKeyId, abi.encodeCall(PasskeyAccount.unfreeze, ()));
        assertFalse(account.frozen());
    }

    // ───────────────────────── 事故：復原 ─────────────────────────

    /// 事故二：所有裝置都遺失。治理方在鏈下重新驗證身分後提案，等 72 小時才生效。
    function test_recovery_afterDelay() public {
        (bytes32 nx, bytes32 ny) = _pub(newPk);
        vm.prank(recoveryAgent);
        account.proposeRecovery(nx, ny, unicode"新手機");

        uint64 readyAt = uint64(block.timestamp + 72 hours);
        vm.expectRevert(abi.encodeWithSelector(PasskeyAccount.RecoveryNotReady.selector, readyAt));
        account.finaliseRecovery();

        vm.warp(block.timestamp + 72 hours);
        account.finaliseRecovery(); // 任何人都能觸發：只是執行一個已經等過、沒被否決的決定

        bytes32 newId = keccak256(abi.encode(nx, ny));
        assertTrue(account.keyOf(newId).active);
        assertEq(account.activeKeys(), 2);

        // 地址沒變，持倉與歷史都還在
        assertEq(twd.balanceOf(address(account)), 100_000e6);

        PasskeyAccount.Call[] memory calls = _approveCall(3);
        account.execute(calls, newId, _sign(newPk, account.getDigest(calls, account.nonce())));
        assertEq(twd.allowance(address(account), address(listing)), 3);
    }

    /// 這 72 小時的意義：讓真正的持有人否決。持有人手上只要還有一把金鑰，接管就不會成立。
    function test_recovery_vetoedByExistingKey() public {
        (bytes32 nx, bytes32 ny) = _pub(newPk);
        vm.prank(recoveryAgent);
        account.proposeRecovery(nx, ny, unicode"不是我申請的");

        _selfCall(phonePk, phoneKeyId, abi.encodeCall(PasskeyAccount.cancelRecovery, ()));

        vm.warp(block.timestamp + 72 hours);
        vm.expectRevert(PasskeyAccount.NoPendingRecovery.selector);
        account.finaliseRecovery();
        assertEq(account.activeKeys(), 1);
    }

    /// 等待期是部署參數，不是常數——公開測試鏈上要能在一次示範裡跑完復原流程，
    /// 而本機測試不能靠 anvil 的 evm_increaseTime 跳過去（公開鏈沒有那條路）。
    /// 這一條守的是：值可以在部署時選，但選完之後**帳戶自己改不了**。
    function test_recoveryDelay_isADeploymentParameter() public {
        PasskeyAccountFactory quick = new PasskeyAccountFactory(recoveryAgent, operator, 10 minutes);
        PasskeyAccount a = quick.createAccount(keccak256("google:quick@example.com"), qx, qy, "phone");
        assertEq(a.RECOVERY_DELAY(), 10 minutes);
        assertEq(account.RECOVERY_DELAY(), 72 hours, unicode"原本那一組不受影響");

        // 等待期是 creationCode 的一部分，所以它也決定地址：換了等待期就是換了一份合約，
        // 不該和舊的共用同一個地址。
        assertTrue(
            quick.getAddress(ACCOUNT_REF) != factory.getAddress(ACCOUNT_REF),
            unicode"等待期不同，同一個 accountRef 也算出不同地址"
        );

        // 提案之後真的只要等 10 分鐘
        vm.prank(recoveryAgent);
        (bytes32 nqx, bytes32 nqy) = _pub(0xB0B);
        a.proposeRecovery(nqx, nqy, unicode"新手機");
        vm.warp(block.timestamp + 10 minutes + 1);
        a.finaliseRecovery();
        assertEq(a.activeKeys(), 2);
    }

    /// 等待期 0 等於治理方可以單方面拿走帳戶——那不會是有人真的想要的設定，
    /// 只會是環境變數寫錯。在建構子就擋下來，別讓它變成一條部署出去的鏈。
    function test_recoveryDelay_zeroRejected() public {
        vm.expectRevert("recoveryDelay = 0");
        new PasskeyAccountFactory(recoveryAgent, operator, 0);
    }

    /// 只有治理方能提案。平台 relayer 不行，登入權更不行——
    /// 這一條是「登入被盜不等於錢包被盜」的實作依據。
    function test_recovery_onlyRecoveryAgentCanPropose() public {
        (bytes32 nx, bytes32 ny) = _pub(newPk);
        vm.prank(operator);
        vm.expectRevert(PasskeyAccount.NotRecoveryAgent.selector);
        account.proposeRecovery(nx, ny, unicode"relayer 想加");

        vm.prank(stranger);
        vm.expectRevert(PasskeyAccount.NotRecoveryAgent.selector);
        account.proposeRecovery(nx, ny, unicode"路人想加");
    }

    function test_recovery_onePendingAtATime() public {
        (bytes32 nx, bytes32 ny) = _pub(newPk);
        vm.startPrank(recoveryAgent);
        account.proposeRecovery(nx, ny, "A");
        vm.expectRevert(PasskeyAccount.RecoveryPending.selector);
        account.proposeRecovery(nx, ny, "B");
        vm.stopPrank();
    }

    /// 復原在凍結期間也要走得通——全部裝置遺失時，帳戶多半已經先被凍起來了。
    function test_recovery_worksWhileFrozen() public {
        vm.prank(operator);
        account.freeze();
        (bytes32 nx, bytes32 ny) = _pub(newPk);
        vm.prank(recoveryAgent);
        account.proposeRecovery(nx, ny, unicode"新手機");
        vm.warp(block.timestamp + 72 hours);
        account.finaliseRecovery();
        assertTrue(account.keyOf(keccak256(abi.encode(nx, ny))).active);

        // 但在解凍之前還是不能動錢；解凍由新拿到的那把金鑰自己做
        bytes32 newId = keccak256(abi.encode(nx, ny));
        PasskeyAccount.Call[] memory calls = _approveCall(1);
        bytes memory sig = _sign(newPk, account.getDigest(calls, account.nonce()));
        vm.expectRevert(PasskeyAccount.AccountFrozen.selector);
        account.execute(calls, newId, sig);
        _selfCall(newPk, newId, abi.encodeCall(PasskeyAccount.unfreeze, ()));
        assertFalse(account.frozen());
    }

    // ───────────────────────── ERC-1271 ─────────────────────────

    function test_erc1271() public {
        bytes32 h = keccak256("hello");
        assertEq(
            account.isValidSignature(h, abi.encode(phoneKeyId, _auth(phonePk, h))),
            IERC1271.isValidSignature.selector
        );
        // 換一把不屬於這個錢包的金鑰
        (bytes32 ox, bytes32 oy) = _pub(laptopPk);
        assertEq(account.isValidSignature(h, abi.encode(keccak256(abi.encode(ox, oy)), _auth(laptopPk, h))), bytes4(0));
        // 凍結期間不對外背書
        vm.prank(operator);
        account.freeze();
        assertEq(account.isValidSignature(h, abi.encode(phoneKeyId, _auth(phonePk, h))), bytes4(0));
    }

    // ───────────────────────── helpers ─────────────────────────

    function _pub(uint256 pk) internal view returns (bytes32, bytes32) {
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);
        return (bytes32(x), bytes32(y));
    }

    function _approveCall(uint256 amount) internal view returns (PasskeyAccount.Call[] memory calls) {
        calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(twd), 0, abi.encodeCall(IERC20.approve, (address(listing), amount)));
    }

    /// 走 executeSelf 對自己下一道指令（加/撤金鑰、凍結、解凍、否決復原）
    function _selfCall(uint256 pk, bytes32 keyId, bytes memory data) internal {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(account), 0, data);
        account.executeSelf(calls, keyId, _sign(pk, account.getDigest(calls, account.nonce())));
    }

    function _addLaptop() internal returns (bytes32 laptopId) {
        (bytes32 ox, bytes32 oy) = _pub(laptopPk);
        _selfCall(phonePk, phoneKeyId, abi.encodeCall(PasskeyAccount.addKey, (ox, oy, unicode"Luphia 的筆電")));
        return keccak256(abi.encode(ox, oy));
    }

    function _addLaptopWhileFrozen() internal returns (bytes32) {
        return _addLaptop(); // addKey 走的就是 executeSelf，凍結中一樣可用
    }

    // ── WebAuthn 斷言組裝（與瀏覽器 navigator.credentials.get 輸出同構）──

    function _sign(uint256 pk, bytes32 digest) internal view returns (bytes memory) {
        return abi.encode(_auth(pk, digest));
    }

    function _auth(uint256 pk, bytes32 digest) internal view returns (WebAuthn.WebAuthnAuth memory) {
        bytes memory authenticatorData = abi.encodePacked(sha256("localhost"), bytes1(0x05), uint32(1));
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"http://localhost:10010","crossOrigin":false}'
        );
        bytes32 messageHash = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, messageHash);
        uint256 sN = uint256(s);
        if (sN > P256_N / 2) sN = P256_N - sN;
        return WebAuthn.WebAuthnAuth({
            authenticatorData: authenticatorData,
            clientDataJSON: clientDataJSON,
            challengeIndex: 23,
            typeIndex: 1,
            r: uint256(r),
            s: sN
        });
    }
}
