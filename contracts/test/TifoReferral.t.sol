// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TifoPromo} from "../src/TifoPromo.sol";
import {TifoFactory} from "../src/TifoFactory.sol";
import {MockUSDC} from "./TifoPromo.t.sol";

/// Referrals: a buyer who brings `refNeeded` new buyers gets what they paid back after full time, whoever wins,
/// paid for by money set aside from those buyers' sales.
contract TifoReferralTest is Test {
    MockUSDC usdc;
    TifoFactory factory;
    address seller = makeAddr("seller");
    address agent = makeAddr("agent");
    address operator = makeAddr("operator");
    uint64 kickoff;

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        factory = new TifoFactory(address(usdc), agent, operator);
        kickoff = uint64(block.timestamp + 1 days);
    }

    function _drop(uint16 rate, uint8 refNeeded) internal returns (TifoPromo p) {
        vm.prank(seller);
        p = TifoPromo(factory.createPromo(bytes32("m"), kickoff, kickoff + 2 hours, 1000e6, rate, rate, rate, rate, 0, 500, 0, 0, 10e6, refNeeded, "{}"));
    }

    function _buy(TifoPromo p, address u, uint8 side, uint256 amt, address ref) internal {
        usdc.mint(u, amt);
        vm.startPrank(u);
        usdc.approve(address(p), amt);
        p.buyRef(side, amt, keccak256(abi.encode(u, amt, usdc.balanceOf(address(p)))), 0, ref);
        vm.stopPrank();
    }

    function _settle(TifoPromo p, TifoPromo.Outcome o) internal {
        vm.warp(kickoff + 2 hours);
        vm.prank(agent);
        p.proposeResult(o, bytes32("e"));
        vm.warp(block.timestamp + 16 minutes);
        p.finalize();
        p.payRefunds(100);
        p.settleReferrals(100);
        p.releaseRemainder();
    }

    function test_threeFriends_referrerGetsEverythingBack_evenIfTheirTeamLoses() public {
        TifoPromo p = _drop(5000, 3);
        address r = makeAddr("r");
        _buy(p, r, 0, 10e6, address(0));
        for (uint160 i = 1; i <= 3; i++) _buy(p, address(0xF000 + i), 1, 10e6, r);
        assertEq(p.refCount(r), 3);
        assertEq(p.refHeld(r), 10e6);
        _settle(p, TifoPromo.Outcome.B); // r's team lost
        assertEq(usdc.balanceOf(r), 10e6); // free anyway
        assertEq(usdc.balanceOf(address(p)), 0);
        assertEq(usdc.balanceOf(seller) + usdc.balanceOf(r) + 3 * 5e6, 40e6); // friends got 50% back each
    }

    function test_referrerWhoAlsoWins_isPaidBackOnce() public {
        TifoPromo p = _drop(5000, 3);
        address r = makeAddr("r");
        _buy(p, r, 0, 10e6, address(0));
        for (uint160 i = 1; i <= 3; i++) _buy(p, address(0xF000 + i), 1, 10e6, r);
        _settle(p, TifoPromo.Outcome.A); // r's team won: $5 from the result, $5 from the referral
        assertEq(usdc.balanceOf(r), 10e6);
        assertEq(p.paidBack(r), 10e6);
        assertEq(usdc.balanceOf(address(p)), 0);
    }

    function test_tooFewFriends_setAsideGoesToTheSeller() public {
        TifoPromo p = _drop(5000, 3);
        address r = makeAddr("r");
        _buy(p, r, 0, 10e6, address(0));
        _buy(p, address(0xF001), 1, 10e6, r);
        _buy(p, address(0xF002), 1, 10e6, r);
        uint256 before = usdc.balanceOf(seller);
        _settle(p, TifoPromo.Outcome.B);
        assertEq(usdc.balanceOf(r), 0);
        assertGt(usdc.balanceOf(seller), before);
        assertEq(usdc.balanceOf(address(p)), 0);
    }

    function test_onlyNewWalletsCount_andNotYourself_andOnlyIfTheReferrerBought() public {
        TifoPromo p = _drop(5000, 2);
        address r = makeAddr("r");
        address stranger = makeAddr("stranger");
        _buy(p, address(0xF001), 0, 10e6, stranger); // stranger never bought: not counted
        assertEq(p.refCount(stranger), 0);
        _buy(p, r, 0, 10e6, address(0));
        _buy(p, r, 0, 10e6, r); // itself
        _buy(p, address(0xF001), 0, 10e6, r); // already a buyer
        assertEq(p.refCount(r), 0);
        _buy(p, address(0xF002), 1, 10e6, r);
        assertEq(p.refCount(r), 1);
    }

    function test_remainderWaitsForReferrals() public {
        TifoPromo p = _drop(5000, 1);
        address r = makeAddr("r");
        _buy(p, r, 0, 10e6, address(0));
        _buy(p, address(0xF001), 1, 10e6, r);
        vm.warp(kickoff + 2 hours);
        vm.prank(agent);
        p.proposeResult(TifoPromo.Outcome.B, 0);
        vm.warp(block.timestamp + 16 minutes);
        p.finalize();
        p.payRefunds(100);
        vm.expectRevert(TifoPromo.RefundsPending.selector);
        p.releaseRemainder();
        p.settleReferrals(10);
        p.releaseRemainder();
        assertEq(usdc.balanceOf(address(p)), 0);
    }

    function test_physicalDropsCannotHaveReferrals() public {
        vm.prank(seller);
        vm.expectRevert(bytes("ref"));
        factory.createPromo(bytes32("m"), kickoff, kickoff + 2 hours, 100e6, 5000, 5000, 5000, 5000, 0, 0, 1 days, 0, 10e6, 3, "{}");
    }

    /// Random buyers, random links, any result: the drop ends empty and nobody gets back more than they paid.
    function testFuzz_referrals_balanceAndNeverOverpay(uint256 seed, uint8 n, uint8 rate, uint8 need, uint8 outcome) public {
        n = uint8(bound(n, 2, 16));
        uint16 r = uint16(bound(rate, 10, 100)) * 100;
        uint8 needed = uint8(bound(need, 1, 4));
        vm.prank(seller);
        TifoPromo p = TifoPromo(factory.createPromo(bytes32("m"), kickoff, kickoff + 2 hours, 1000e6, r, r, r, r, 0, 500, 0, 0, 1e6, needed, "{}"));
        address[] memory w = new address[](n);
        uint256[] memory paid = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            w[i] = address(uint160(0xA000 + i));
            uint256 amt = bound(uint256(keccak256(abi.encode(seed, i))), 1e6, 30e6);
            address ref = i > 0 ? w[uint256(keccak256(abi.encode(seed, i, "r"))) % i] : address(0);
            _buy(p, w[i], uint8(uint256(keccak256(abi.encode(seed, i, "s"))) % 2), amt, ref);
            paid[i] = amt;
        }
        uint256 sellerBefore = usdc.balanceOf(seller);
        _settle(p, TifoPromo.Outcome(1 + (outcome % 4)));
        assertEq(usdc.balanceOf(address(p)), 0);
        for (uint256 i = 0; i < n; i++) assertLe(usdc.balanceOf(w[i]), paid[i]);
        assertGe(usdc.balanceOf(seller), sellerBefore);
    }
}
