// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {CarbonPool} from "../src/market/CarbonPool.sol";
import {CarbonCreditToken} from "../src/market/CarbonCreditToken.sol";
import {CarbonCredit1155} from "../src/registry/CarbonCredit1155.sol";
import {RetirementCertificate} from "../src/registry/RetirementCertificate.sol";

/// @notice 對 CarbonPool 做隨機操作序列（存入、FIFO 贖回、指定贖回、贖回並註銷），檢查不變式。
contract PoolHandler is Test {
    CarbonPool public pool;
    CarbonCreditToken public cct;
    CarbonCredit1155 public credit;
    address public actor; // companyA：法人，可存入與贖回
    uint256[] public batches;
    uint256 public ghostRetiredKg;

    constructor(CarbonPool pool_, CarbonCreditToken cct_, CarbonCredit1155 credit_, address actor_, uint256[] memory batches_) {
        pool = pool_;
        cct = cct_;
        credit = credit_;
        actor = actor_;
        batches = batches_;
    }

    function deposit(uint256 idx, uint256 kg) external {
        uint256 id = batches[idx % batches.length];
        uint256 bal = credit.balanceOf(actor, id);
        if (bal == 0) return;
        kg = bound(kg, 1, bal);
        vm.prank(actor);
        pool.deposit(id, kg);
    }

    function redeem(uint256 kg) external {
        uint256 max = cct.balanceOf(actor) / 1e15;
        if (max == 0) return;
        kg = bound(kg, 1, max);
        vm.prank(actor);
        try pool.redeem(kg) {} catch {}
    }

    function redeemSpecific(uint256 idx, uint256 kg) external {
        uint256 id = batches[idx % batches.length];
        uint256 pooled = pool.pooledKg(id);
        if (pooled == 0) return;
        kg = bound(kg, 1, pooled);
        uint256 need = kg * 1e15;
        uint256 fee = need * pool.selectiveRedeemFeeBps() / 10_000;
        if (cct.balanceOf(actor) < need + fee) return;
        vm.prank(actor);
        pool.redeemSpecific(id, kg);
    }

    function redeemAndRetire(uint256 kg) external {
        uint256 max = cct.balanceOf(actor) / 1e15;
        if (max == 0) return;
        kg = bound(kg, 1, max);
        vm.prank(actor);
        try pool.redeemAndRetire(kg, keccak256("b"), "B", RetirementCertificate.Purpose.VoluntaryNeutrality, "") {
            ghostRetiredKg += kg;
        } catch {}
    }
}

contract PoolInvariantTest is StdInvariant, Fixture {
    PoolHandler internal handler;
    uint256[] internal batchIds;
    uint256 internal totalIssued;

    function setUp() public override {
        super.setUp();
        uint256 pid = _registerProject(companyA);
        for (uint256 i = 0; i < 4; i++) {
            uint256 kg = 10_000 * (i + 1);
            batchIds.push(_issue(pid, kg, keccak256(abi.encode("INV", i))));
            totalIssued += kg;
        }
        vm.prank(companyA);
        credit.setApprovalForAll(address(pool), true);
        handler = new PoolHandler(pool, cct, credit, companyA, batchIds);
        targetContract(address(handler));
    }

    /// CCT 總供給永遠等於池內 kg × 1e15（含國庫持有的手續費 CCT）
    function invariant_backing() public view {
        uint256 pooled;
        for (uint256 i = 0; i < batchIds.length; i++) pooled += pool.pooledKg(batchIds[i]);
        assertEq(cct.totalSupply(), pooled * 1e15);
    }

    /// 池內 kg == 池合約實際持有的 1155 餘額
    function invariant_poolHoldsWhatItCounts() public view {
        for (uint256 i = 0; i < batchIds.length; i++) {
            assertEq(credit.balanceOf(address(pool), batchIds[i]), pool.pooledKg(batchIds[i]));
        }
    }

    /// 額度守恆：持有 + 池內 + 已註銷 == 核發
    function invariant_conservation() public view {
        uint256 sum;
        for (uint256 i = 0; i < batchIds.length; i++) {
            uint256 id = batchIds[i];
            sum += credit.balanceOf(companyA, id) + credit.balanceOf(address(pool), id) + credit.batchOf(id).retiredKg;
        }
        assertEq(sum, totalIssued);
    }

    /// 註銷量與憑證一致
    function invariant_retiredMatchesGhost() public view {
        uint256 retired;
        for (uint256 i = 0; i < batchIds.length; i++) retired += credit.batchOf(batchIds[i]).retiredKg;
        assertEq(retired, handler.ghostRetiredKg());
    }
}
