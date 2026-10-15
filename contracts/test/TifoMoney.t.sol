// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TifoPromo} from "../src/TifoPromo.sol";
import {TifoFactory} from "../src/TifoFactory.sol";
import {TifoAccount} from "../src/TifoAccount.sol";
import {MockUSDC} from "./TifoPromo.t.sol";

/// The money rules added on 10 Oct: free spots with a floor, the draw thank you, and the seller's account.
contract TifoMoneyTest is Test {
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

    function _fan(uint256 i, TifoPromo promo, uint8 side, uint256 amt, uint16 minRate) internal returns (address u) {
        u = address(uint160(0xF000 + i));
        usdc.mint(u, amt);
        vm.startPrank(u);
        usdc.approve(address(promo), amt);
        promo.buy(side, amt, bytes32(i), minRate);
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

    /// $100 budget, $20 product, "free if your team wins": five spots per side, then the floor.
    function test_freeSpots_sixthBuyerGetsTheFloor() public {
        vm.prank(seller);
        TifoPromo promo = TifoPromo(factory.createPromo(bytes32("m"), kickoff, kickoff + 105 minutes, 100e6, 10_000, 10_000, 10_000, 10_000, 0, 0, 0, 0, 0, "{}"));
        for (uint256 i; i < 5; i++) _fan(i, promo, 0, 20e6, 10_000);

        // The sixth buyer who was shown "free" is refused rather than silently given less.
        address late = address(uint160(0xF000 + 5));
        usdc.mint(late, 20e6);
        vm.startPrank(late);
        usdc.approve(address(promo), 20e6);
        vm.expectRevert(TifoPromo.OfferGone.selector);
        promo.buy(0, 20e6, bytes32("late"), 10_000);
        // Shown the floor, they can still buy.
        promo.buy(0, 20e6, bytes32("late"), 0);
        vm.stopPrank();

        (, , uint256 la, uint256 lb, uint256 r, , ) = promo.book();
        assertEq(la, 100e6);
        assertEq(lb, 0);
        assertEq(r, 100e6);
        // The other side still has all five of its spots.
        for (uint256 i = 10; i < 15; i++) _fan(i, promo, 1, 20e6, 10_000);
        (, , , lb, r, , ) = promo.book();
        assertEq(lb, 100e6);
        assertEq(r, 100e6);

        _settle(promo, TifoPromo.Outcome.A);
        assertEq(promo.refundedTotal(), 100e6);
        assertEq(usdc.balanceOf(address(uint160(0xF000))), 20e6); // a free spot: full price back
        assertEq(usdc.balanceOf(late), 0); // the floor buyer paid full price
        assertEq(usdc.balanceOf(seller), 11 * 20e6 - 100e6);
        assertEq(usdc.balanceOf(address(promo)), 0);
    }

    function test_drawPaysEveryBuyerTheThankYou() public {
        vm.prank(seller);
        TifoPromo promo = TifoPromo(factory.createPromo(bytes32("m"), kickoff, kickoff + 105 minutes, 100e6, 500, 6000, 3000, 4000, 0, 500, 0, 0, 0, "{}"));
        address a = _fan(1, promo, 0, 40e6, 0);
        address b = _fan(2, promo, 1, 20e6, 0);
        assertEq(promo.drawLiability(), 3e6);

        _settle(promo, TifoPromo.Outcome.Draw);
        assertEq(usdc.balanceOf(a), 2e6);
        assertEq(usdc.balanceOf(b), 1e6);
        assertEq(promo.refundedTotal(), 3e6);
        assertEq(usdc.balanceOf(seller), 57e6);
        assertEq(usdc.balanceOf(address(promo)), 0);
    }

    /// A checkout that times out and retries sends the same order reference. It must not charge twice.
    function test_sameOrderReferenceIsChargedOnce() public {
        vm.prank(seller);
        TifoPromo promo = TifoPromo(factory.createPromo(bytes32("m"), kickoff, kickoff + 105 minutes, 100e6, 500, 6000, 3000, 4000, 0, 0, 0, 0, 0, "{}"));
        address u = makeAddr("retry");
        usdc.mint(u, 40e6);
        vm.startPrank(u);
        usdc.approve(address(promo), 40e6);
        promo.buy(0, 20e6, bytes32("order-7"), 0);
        vm.expectRevert(TifoPromo.DuplicateOrder.selector);
        promo.buy(0, 20e6, bytes32("order-7"), 0);
        vm.stopPrank();
        assertEq(usdc.balanceOf(u), 20e6);
        assertEq(promo.salesTotal(), 20e6);
    }

    function _terms(uint256 cap) internal view returns (TifoAccount.Terms memory) {
        return TifoAccount.Terms(bytes32("m"), kickoff, kickoff + 105 minutes, cap, 500, 6000, 3000, 4000, 0, 500, 0, 0, 0);
    }

    function test_account_agentActsInsideTheRuleAndOnlyProposesOutsideIt() public {
        // The owner lets the agent risk $50 a week plus 10% of last week's sales, and at most $40 on one drop.
        vm.prank(seller);
        TifoAccount acct = TifoAccount(factory.createAccount(1000, 50e6, 40e6, address(0)));
        assertEq(factory.accountOf(seller), address(acct));

        vm.startPrank(agent);
        TifoPromo first = TifoPromo(acct.openDeal(_terms(30e6), "{}", "first drop of the week"));
        assertEq(first.seller(), address(acct));
        vm.expectRevert(TifoAccount.OverLimit.selector); // over the per drop limit
        acct.openDeal(_terms(41e6), "{}", "too big");
        vm.expectRevert(TifoAccount.OverLimit.selector); // 30 + 25 > 50 this week
        acct.openDeal(_terms(25e6), "{}", "too much this week");
        uint256 id = acct.propose(_terms(25e6), "{}", "a second match worth the extra budget");
        vm.expectRevert(TifoAccount.NotOwner.selector);
        acct.decide(id, true);
        vm.expectRevert(TifoAccount.NotOwner.selector);
        acct.withdraw(agent, 1);
        vm.stopPrank();

        // Sales land in the account, and only the owner can take them out.
        _fan(1, first, 0, 100e6, 0);
        assertEq(usdc.balanceOf(address(acct)), 70e6);
        vm.prank(seller);
        acct.withdraw(seller, 70e6);
        assertEq(usdc.balanceOf(seller), 70e6);

        // The owner approves the proposal, which opens the drop.
        vm.prank(seller);
        address second = acct.decide(id, true);
        assertTrue(second != address(0));
        assertEq(acct.committed(), 55e6);
        vm.prank(seller);
        vm.expectRevert(TifoAccount.AlreadyDecided.selector);
        acct.decide(id, true);

        // Next week the allowance grows with last week's sales: 50 + 10% of 100.
        vm.warp(kickoff + 1 hours);
        assertEq(acct.recentSales(), 100e6);
        assertEq(acct.allowance(), 60e6);
        vm.warp(block.timestamp + 7 days);
        assertEq(acct.committed(), 0);
    }
}
