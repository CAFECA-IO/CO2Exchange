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
import {RetirementCertificate} from "../src/registry/RetirementCertificate.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice 用 forge 的 P-256 cheatcode 組出完整 WebAuthn 斷言，走「relayer 代送」的自然人購買 + 註銷流程。
contract PasskeyAccountTest is Fixture {
    uint256 constant P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
    uint256 internal passkeyPk = 0x5EED;
    bytes32 internal qx;
    bytes32 internal qy;
    PasskeyAccountFactory internal factory;
    PasskeyAccount internal account;
    address internal relayer = makeAddr("relayer");
    uint256 internal batch;

    function setUp() public override {
        super.setUp();
        (uint256 x, uint256 y) = vm.publicKeyP256(passkeyPk);
        (qx, qy) = (bytes32(x), bytes32(y));
        factory = new PasskeyAccountFactory();

        // relayer 代為部署帳戶（地址可預測）
        address predicted = factory.getAddress(qx, qy);
        vm.prank(relayer);
        account = factory.createAccount(qx, qy);
        assertEq(address(account), predicted);

        // 身分綁在帳戶地址
        _registerIdentity(address(account), IKYCRegistry.Tier.Individual, keccak256("TW-ID-B222"));
        vm.prank(operator);
        twd.mint(address(account), 100_000e6);

        // 市場上有一張掛單
        uint256 pid = _registerProject(companyA);
        batch = _issue(pid, 10_000, keccak256("PK1"));
        vm.startPrank(companyA);
        credit.setApprovalForAll(address(listing), true);
        listing.list(batch, 10_000, 800e6, 0);
        vm.stopPrank();
    }

    function test_factory_isIdempotentAndDeterministic() public {
        PasskeyAccount again = factory.createAccount(qx, qy);
        assertEq(address(again), address(account));
    }

    function test_execute_buyThenRetire_viaRelayer() public {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](2);
        calls[0] = PasskeyAccount.Call(address(twd), 0, abi.encodeCall(IERC20.approve, (address(listing), 2_000e6)));
        calls[1] = PasskeyAccount.Call(address(listing), 0, abi.encodeCall(Listing.buy, (1, 2_000)));
        bytes memory sig = _sign(account.getDigest(calls, account.nonce()));

        vm.prank(relayer);
        account.execute(calls, sig);
        assertEq(credit.balanceOf(address(account), batch), 2_000);
        assertEq(account.nonce(), 1);

        // 註銷
        PasskeyAccount.Call[] memory retireCalls = new PasskeyAccount.Call[](1);
        retireCalls[0] = PasskeyAccount.Call(
            address(credit),
            0,
            abi.encodeCall(CarbonCredit1155.retire, (_retireReq(address(account), batch, 2_000, address(account))))
        );
        vm.prank(relayer);
        account.execute(retireCalls, _sign(account.getDigest(retireCalls, 1)));
        assertEq(cert.balanceOf(address(account)), 1);
        assertEq(credit.batchOf(batch).retiredKg, 2_000);
    }

    function test_execute_replayRejected() public {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(twd), 0, abi.encodeCall(IERC20.approve, (address(listing), 1)));
        bytes memory sig = _sign(account.getDigest(calls, 0));
        account.execute(calls, sig);
        vm.expectRevert(PasskeyAccount.InvalidSignature.selector);
        account.execute(calls, sig);
    }

    function test_execute_tamperedCallRejected() public {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(twd), 0, abi.encodeCall(IERC20.approve, (address(listing), 1)));
        bytes memory sig = _sign(account.getDigest(calls, 0));
        calls[0].data = abi.encodeCall(IERC20.approve, (address(listing), 2));
        vm.expectRevert(PasskeyAccount.InvalidSignature.selector);
        account.execute(calls, sig);
    }

    function test_execute_wrongKeyRejected() public {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(twd), 0, abi.encodeCall(IERC20.approve, (address(listing), 1)));
        bytes memory sig = _signWith(0xBAD, account.getDigest(calls, 0));
        vm.expectRevert(PasskeyAccount.InvalidSignature.selector);
        account.execute(calls, sig);
    }

    function test_execute_innerRevertBubbles() public {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(listing), 0, abi.encodeCall(Listing.buy, (1, 2_000))); // 沒 approve
        bytes memory sig = _sign(account.getDigest(calls, 0));
        vm.expectRevert();
        account.execute(calls, sig);
    }

    function test_erc1271() public view {
        bytes32 h = keccak256("hello");
        assertEq(account.isValidSignature(h, _sign(h)), IERC1271.isValidSignature.selector);
        assertEq(account.isValidSignature(h, _signWith(0xBAD, h)), bytes4(0));
    }

    // ── WebAuthn 斷言組裝（與瀏覽器 navigator.credentials.get 輸出同構）──

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        return _signWith(passkeyPk, digest);
    }

    function _signWith(uint256 pk, bytes32 digest) internal view returns (bytes memory) {
        bytes memory authenticatorData = abi.encodePacked(sha256("localhost"), bytes1(0x05), uint32(1));
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"http://localhost:3000","crossOrigin":false}'
        );
        bytes32 messageHash = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, messageHash);
        uint256 sN = uint256(s);
        if (sN > P256_N / 2) sN = P256_N - sN;
        return abi.encode(
            WebAuthn.WebAuthnAuth({
                authenticatorData: authenticatorData,
                clientDataJSON: clientDataJSON,
                challengeIndex: 23,
                typeIndex: 1,
                r: uint256(r),
                s: sN
            })
        );
    }
}
