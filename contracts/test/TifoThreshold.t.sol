// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TifoPromo} from "../src/TifoPromo.sol";
import {TifoFactory} from "../src/TifoFactory.sol";
import {TifoAccount} from "../src/TifoAccount.sol";
import {MockUSDC} from "./TifoPromo.t.sol";

/// The offer switches on with enough buyers: below `minBuyers` different wallets, nobody is paid back
/// and the seller keeps every sale.
contract TifoThresholdTest is Test {
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

    /// $4 product, "free if your team wins", $20 budget, the offer switches on at `minBuyers`.
    function _drop(uint32 minBuyers) internal returns (TifoPromo promo) {
        vm.prank(seller);
        promo = TifoPromo(factory.createPromo(bytes32("m"), kickoff, kickoff + 105 minutes, 20e6, 10_000, 10_000, 10_000, 10_000, 0, 500, 0, minBuyers, 0, "{}"));
    }

    function _fan(uint256 i, TifoPromo promo, uint8 side) internal returns (address u) {
        u = address(uint160(0xF000 + i));
        usdc.mint(u, 4e6);
        vm.startPrank(u);
        usdc.approve(address(promo), 4e6);
        promo.buy(side, 4e6, bytes32(0), 0);
        vm.stopPrank();
    }

    function _settle(TifoPromo promo, TifoPromo.Outcome o) internal {
        vm.warp(kickoff + 2 hours);
        vm.prank(agent);
        promo.proposeResult(o, bytes32("evidence"));
        vm.warp(block.timestamp + 16 minutes);
        promo.finalize();
        promo.payRefunds(200);
        promo.releaseRemainder();
    }

    function test_oneBuyerBelowTheLine_sellerKeepsTheSale() public {
        TifoPromo promo = _drop(5);
        address fan = _fan(1, promo, 0);
        assertEq(promo.buyers(), 1);
        assertFalse(promo.offerOn());

        _settle(promo, TifoPromo.Outcome.A);
        assertEq(usdc.balanceOf(fan), 0); // their team won, but the offer never switched on
        assertEq(promo.refundedTotal(), 0);
        assertEq(usdc.balanceOf(seller), 4e6); // the whole sale
        assertEq(usdc.balanceOf(address(promo)), 0);
    }

    function test_drawBelowTheLine_paysNoThankYou() public {
        TifoPromo promo = _drop(3);
        _fan(1, promo, 0);
        _fan(2, promo, 1);
        _settle(promo, TifoPromo.Outcome.Draw);
        assertEq(promo.refundedTotal(), 0);
        assertEq(usdc.balanceOf(seller), 8e6);
    }

    function test_reachingTheLine_paysWinnersAsUsual() public {
        TifoPromo promo = _drop(3);
        address a1 = _fan(1, promo, 0);
        address a2 = _fan(2, promo, 0);
        address b1 = _fan(3, promo, 1);
        assertTrue(promo.offerOn());

        _settle(promo, TifoPromo.Outcome.A);
        assertEq(usdc.balanceOf(a1), 4e6); // free
        assertEq(usdc.balanceOf(a2), 4e6);
        assertEq(usdc.balanceOf(b1), 0);
        assertEq(promo.refundedTotal(), 8e6);
        assertEq(usdc.balanceOf(seller), 12e6 - 8e6);
        assertEq(usdc.balanceOf(address(promo)), 0);
    }

    function test_sameWalletBuyingTwice_countsOnce() public {
        TifoPromo promo = _drop(2);
        address u = _fan(1, promo, 0);
        usdc.mint(u, 4e6);
        vm.startPrank(u);
        usdc.approve(address(promo), 4e6);
        promo.buy(0, 4e6, bytes32(0), 0);
        vm.stopPrank();
        assertEq(promo.buyers(), 1);
        assertFalse(promo.offerOn());

        _settle(promo, TifoPromo.Outcome.A);
        assertEq(usdc.balanceOf(u), 0);
        assertEq(usdc.balanceOf(seller), 8e6);
    }

    function test_zero_isOnFromTheFirstSale() public {
        TifoPromo promo = _drop(0);
        assertTrue(promo.offerOn()); // nothing to reach
        address fan = _fan(10, promo, 1);
        _settle(promo, TifoPromo.Outcome.B);
        assertEq(usdc.balanceOf(fan), 4e6);
    }

    function test_one_isOnFromTheFirstSale() public {
        TifoPromo promo = _drop(1);
        assertFalse(promo.offerOn());
        address fan = _fan(11, promo, 1);
        assertTrue(promo.offerOn());
        _settle(promo, TifoPromo.Outcome.B);
        assertEq(usdc.balanceOf(fan), 4e6);
    }

    function test_voidBelowTheLine_stillReleases() public {
        TifoPromo promo = _drop(5);
        _fan(1, promo, 0);
        vm.warp(kickoff + 3 days + 1);
        promo.finalize(); // nobody settled it: void
        promo.payRefunds(10);
        promo.releaseRemainder();
        assertEq(usdc.balanceOf(seller), 4e6);
        assertEq(usdc.balanceOf(address(promo)), 0);
    }

    function test_accountDropsCarryTheLine() public {
        vm.prank(seller);
        (address account, address p) = factory.createAccountAndOpen(
            1000, 20e6, 20e6, address(0), TifoAccount.Terms(bytes32("m"), kickoff, kickoff + 105 minutes, 20e6, 10_000, 10_000, 10_000, 10_000, 0, 0, 0, 4, 0), "{}"
        );
        assertTrue(account != address(0));
        assertEq(TifoPromo(p).minBuyers(), 4);
    }
}
