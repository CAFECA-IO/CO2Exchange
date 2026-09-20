// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IKYCRegistry} from "../src/interfaces/IKYCRegistry.sol";
import {KYCRegistry} from "../src/identity/KYCRegistry.sol";
import {Listing} from "../src/market/Listing.sol";
import {CarbonPool} from "../src/market/CarbonPool.sol";
import {WebAuthn} from "../src/account/WebAuthn.sol";

/// @notice 屬性測試：以隨機輸入驗證「不該被打破的關係」。
contract FuzzTest is Fixture {
    uint256 constant P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;

    // ── Listing：成交數學 ──

    /// 任意數量與價格下：買方付出 = 賣方收到 + 國庫手續費；成交後剩餘量正確；額度轉移量正確
    function testFuzz_listing_buyAccounting(uint96 issuedKg, uint96 buyKg, uint64 pricePerTonne, uint16 feeBps) public {
        issuedKg = uint96(bound(issuedKg, 1, 10_000_000)); // ≤ 10,000 噸
        buyKg = uint96(bound(buyKg, 1, issuedKg));
        pricePerTonne = uint64(bound(pricePerTonne, 1, 100_000e6));
        feeBps = uint16(bound(feeBps, 0, 500));
        vm.prank(operator);
        listing.setFee(feeBps, treasury);

        uint256 pid = _registerProject(companyA);
        uint256 batch = _issue(pid, issuedKg, keccak256(abi.encode("F", issuedKg, buyKg)));
        vm.startPrank(companyA);
        credit.setApprovalForAll(address(listing), true);
        uint256 orderId = listing.list(batch, issuedKg, pricePerTonne, 0);
        vm.stopPrank();

        uint256 cost = uint256(buyKg) * pricePerTonne / 1000;
        uint256 fee = cost * feeBps / 10_000;
        vm.prank(operator);
        twd.mint(alice, cost);
        uint256 aliceBefore = twd.balanceOf(alice);
        uint256 sellerBefore = twd.balanceOf(companyA);
        uint256 treasuryBefore = twd.balanceOf(treasury);

        vm.startPrank(alice);
        twd.approve(address(listing), cost);
        listing.buy(orderId, buyKg);
        vm.stopPrank();

        assertEq(aliceBefore - twd.balanceOf(alice), cost, "buyer pays exactly cost");
        assertEq(twd.balanceOf(companyA) - sellerBefore, cost - fee, "seller gets cost - fee");
        assertEq(twd.balanceOf(treasury) - treasuryBefore, fee, "treasury gets fee");
        assertEq(credit.balanceOf(alice, batch), buyKg);
        assertEq(listing.orderOf(orderId).remainingKg, issuedKg - buyKg);
        assertEq(listing.orderOf(orderId).active, buyKg != issuedKg);
    }

    /// minFill：低於最小成交量且非最後一筆 → 必拒
    function testFuzz_listing_minFillEnforced(uint32 total, uint32 minFill, uint32 buyKg) public {
        total = uint32(bound(total, 2, 1_000_000));
        minFill = uint32(bound(minFill, 2, total));
        buyKg = uint32(bound(buyKg, 1, minFill - 1));
        vm.assume(buyKg != total);
        uint256 pid = _registerProject(companyA);
        uint256 batch = _issue(pid, total, keccak256(abi.encode("M", total, minFill)));
        vm.startPrank(companyA);
        credit.setApprovalForAll(address(listing), true);
        uint256 orderId = listing.list(batch, total, 800e6, minFill);
        vm.stopPrank();
        vm.startPrank(alice);
        twd.approve(address(listing), type(uint256).max);
        vm.expectRevert(Listing.BelowMinFill.selector);
        listing.buy(orderId, buyKg);
        vm.stopPrank();
    }

    // ── CarbonPool：1:1 backing 與 FIFO ──

    /// 任意存入 / FIFO 贖回 / 指定贖回序列後：CCT 總供給 == 池內 kg × 1e15
    function testFuzz_pool_backingHolds(uint32 a, uint32 b, uint32 redeemKg, uint32 specificKg, uint16 feeBps) public {
        a = uint32(bound(a, 1, 500_000));
        b = uint32(bound(b, 1, 500_000));
        feeBps = uint16(bound(feeBps, 0, 2000));
        vm.prank(operator);
        pool.setFee(feeBps, treasury);
        uint256 pid = _registerProject(companyA);
        uint256 b1 = _issue(pid, a, keccak256(abi.encode("P1", a, b)));
        uint256 b2 = _issue(pid, b, keccak256(abi.encode("P2", a, b)));
        vm.startPrank(companyA);
        credit.setApprovalForAll(address(pool), true);
        pool.deposit(b1, a);
        pool.deposit(b2, b);
        assertEq(cct.totalSupply(), (uint256(a) + b) * 1e15);

        redeemKg = uint32(bound(redeemKg, 1, uint256(a) + b));
        pool.redeem(redeemKg);
        uint256 leftB2 = pool.pooledKg(b2);
        if (leftB2 > 0) {
            specificKg = uint32(bound(specificKg, 1, leftB2));
            uint256 need = uint256(specificKg) * 1e15;
            uint256 fee = need * feeBps / 10_000;
            if (cct.balanceOf(companyA) >= need + fee) pool.redeemSpecific(b2, specificKg);
        }
        vm.stopPrank();
        assertEq(cct.totalSupply(), (pool.pooledKg(b1) + pool.pooledKg(b2)) * 1e15, "1:1 backing");
    }

    /// FIFO：贖回量 ≤ 第一批存量時，必定只動第一批
    function testFuzz_pool_fifoTakesOldestFirst(uint32 a, uint32 b, uint32 redeemKg) public {
        a = uint32(bound(a, 1, 500_000));
        b = uint32(bound(b, 1, 500_000));
        redeemKg = uint32(bound(redeemKg, 1, a));
        uint256 pid = _registerProject(companyA);
        uint256 b1 = _issue(pid, a, keccak256(abi.encode("Q1", a, b)));
        uint256 b2 = _issue(pid, b, keccak256(abi.encode("Q2", a, b)));
        vm.startPrank(companyA);
        credit.setApprovalForAll(address(pool), true);
        pool.deposit(b1, a);
        pool.deposit(b2, b);
        (uint256[] memory ids, uint256[] memory amounts) = pool.redeem(redeemKg);
        vm.stopPrank();
        assertEq(ids.length, 1);
        assertEq(ids[0], b1);
        assertEq(amounts[0], redeemKg);
        assertEq(pool.pooledKg(b2), b);
    }

    // ── KYC 白名單：轉帳規則 ──

    /// 任意 tier 組合：轉帳成功 ⇔ 雙方有效且未凍結，且（from 非自然人 或 政策開啟）
    function testFuzz_kyc_transferRule(uint8 fromTier, uint8 toTier, bool fromFrozen, bool toFrozen, bool policy) public {
        fromTier = uint8(bound(fromTier, 1, 2));
        toTier = uint8(bound(toTier, 0, 2));
        address from = makeAddr("from");
        address to = makeAddr("to");
        _registerIdentity(from, IKYCRegistry.Tier(fromTier), keccak256("from"));
        if (toTier != 0) _registerIdentity(to, IKYCRegistry.Tier(toTier), keccak256("to"));
        vm.startPrank(sovereign);
        kyc.setFrozen(from, fromFrozen);
        kyc.setFrozen(to, toFrozen);
        kyc.setIndividualTransferEnabled(policy);
        vm.stopPrank();

        // 給 from 一些額度（暫時關掉政策以便 mint 後轉入 from）
        uint256 pid = _registerProject(companyA);
        uint256 batch = _issue(pid, 1000, keccak256(abi.encode("K", fromTier, toTier, fromFrozen, toFrozen, policy)));
        vm.prank(sovereign);
        kyc.setFrozen(from, false);
        vm.prank(companyA);
        credit.safeTransferFrom(companyA, from, batch, 1000, "");
        vm.prank(sovereign);
        kyc.setFrozen(from, fromFrozen);

        bool expectOk = !fromFrozen && !toFrozen && toTier != 0 && (fromTier != 1 || policy);
        vm.prank(from);
        if (expectOk) {
            credit.safeTransferFrom(from, to, batch, 1, "");
            assertEq(credit.balanceOf(to, batch), 1);
        } else {
            vm.expectRevert();
            credit.safeTransferFrom(from, to, batch, 1, "");
        }
    }

    /// 註銷：retiredKg 永遠 ≤ issuedKg，且 burn 量 == retiredKg
    function testFuzz_retire_neverExceedsIssued(uint32 issued, uint32 r1, uint32 r2) public {
        issued = uint32(bound(issued, 2, 1_000_000));
        r1 = uint32(bound(r1, 1, issued - 1));
        r2 = uint32(bound(r2, 1, issued));
        uint256 pid = _registerProject(companyA);
        uint256 batch = _issue(pid, issued, keccak256(abi.encode("R", issued, r1, r2)));
        vm.startPrank(companyA);
        credit.retire(_retireReq(companyA, batch, r1, companyA));
        if (r2 <= issued - r1) credit.retire(_retireReq(companyA, batch, r2, companyA));
        else {
            vm.expectRevert();
            credit.retire(_retireReq(companyA, batch, r2, companyA));
        }
        vm.stopPrank();
        uint256 retired = credit.batchOf(batch).retiredKg;
        assertLe(retired, issued);
        assertEq(credit.balanceOf(companyA, batch), issued - retired);
    }

    // ── WebAuthn：簽章邊界 ──

    /// 任意 digest 與私鑰：正確簽章通過；改動 challenge、r、s 任一位元即失敗；high-s 被拒；缺 UP 旗標被拒
    function testFuzz_webauthn_verifyBoundaries(uint256 pk, bytes32 digest, uint8 flip) public {
        pk = bound(pk, 1, P256_N - 1);
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);
        WebAuthn.WebAuthnAuth memory auth = _assert(pk, digest);

        assertTrue(WebAuthn.verify(abi.encodePacked(digest), false, auth, bytes32(x), bytes32(y)), "valid");
        assertTrue(WebAuthn.verify(abi.encodePacked(digest), true, auth, bytes32(x), bytes32(y)), "valid with UV");
        _checkTampered(auth, digest, flip, x, y);
    }

    function _assert(uint256 pk, bytes32 digest) internal view returns (WebAuthn.WebAuthnAuth memory) {
        bytes memory authData = abi.encodePacked(sha256("localhost"), bytes1(0x05), uint32(7));
        string memory cdj = string.concat(
            '{"type":"webauthn.get","challenge":"', Base64.encodeURL(abi.encodePacked(digest)), '","origin":"http://localhost:10010"}'
        );
        (bytes32 r, bytes32 s) = vm.signP256(pk, sha256(abi.encodePacked(authData, sha256(bytes(cdj)))));
        uint256 sN = uint256(s);
        if (sN > P256_N / 2) sN = P256_N - sN;
        return WebAuthn.WebAuthnAuth(authData, cdj, 23, 1, uint256(r), sN);
    }

    function _checkTampered(WebAuthn.WebAuthnAuth memory auth, bytes32 digest, uint8 flip, uint256 x, uint256 y) internal view {
        bytes memory ch = abi.encodePacked(digest);
        WebAuthn.WebAuthnAuth memory t = auth;
        t.s = P256_N - auth.s;
        assertFalse(WebAuthn.verify(ch, false, t, bytes32(x), bytes32(y)), "high-s rejected");
        t = auth;
        t.r = auth.r ^ (uint256(1) << (flip % 256));
        assertFalse(WebAuthn.verify(ch, false, t, bytes32(x), bytes32(y)), "bad r");
        t = auth;
        t.authenticatorData = abi.encodePacked(sha256("localhost"), bytes1(0x04), uint32(7));
        assertFalse(WebAuthn.verify(ch, false, t, bytes32(x), bytes32(y)), "UP required");
        bytes32 other = digest ^ bytes32(uint256(1) << (flip % 256));
        assertFalse(WebAuthn.verify(abi.encodePacked(other), false, auth, bytes32(x), bytes32(y)), "challenge mismatch");
    }

    /// attestation nonce 綁定：同一份 attestation 不可重放（任意 tier / expiry）
    function testFuzz_kyc_attestationReplay(uint8 tier, uint64 expiry) public {
        tier = uint8(bound(tier, 1, 2));
        expiry = uint64(bound(expiry, vm.getBlockTimestamp() + 1, type(uint64).max));
        address acct = makeAddr("acct");
        (KYCRegistry.IdentityAttestation memory a, bytes memory sig) = _attest(acct, IKYCRegistry.Tier(tier), keccak256("h"), expiry);
        kyc.register(a, sig);
        vm.expectRevert(KYCRegistry.InvalidAttestation.selector);
        kyc.register(a, sig);
    }
}
