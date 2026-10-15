// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TifoPromo} from "../src/TifoPromo.sol";
import {TifoFactory} from "../src/TifoFactory.sol";
import {MockUSDC} from "./TifoPromo.t.sol";

/// USDC that refuses transfers to one blocked wallet, as Circle's blocklist does.
contract BlockingUSDC is MockUSDC {
    address public blocked;

    function block_(address who) external {
        blocked = who;
    }

    function transfer(address to, uint256 amt) external override returns (bool) {
        require(to != blocked, "blocked");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// The guards added after the release audit: a minimum price, whole refunds for unsent physical orders,
/// one result proposal, relayer-only permits, and refunds that a blocked wallet cannot stop.
contract TifoGuardsTest is Test {
    BlockingUSDC usdc;
    TifoFactory factory;
    address seller = makeAddr("seller");
    address agent = makeAddr("agent");
    address operator = makeAddr("operator");
    uint64 kickoff;

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new BlockingUSDC();
        factory = new TifoFactory(address(usdc), agent, operator);
        kickoff = uint64(block.timestamp + 1 days);
    }

    function _drop(uint256 cap, uint16 rate, uint16 draw, uint32 hold, uint32 minBuyers, uint256 price) internal returns (TifoPromo p) {
        vm.prank(seller);
        p = TifoPromo(factory.createPromo(bytes32("m"), kickoff, kickoff + 2 hours, cap, rate, rate, rate, rate, 0, draw, hold, minBuyers, price, 0, "{}"));
    }

    function _buy(TifoPromo p, address u, uint8 side, uint256 amt, bytes32 ref) internal {
        usdc.mint(u, amt);
        vm.startPrank(u);
        usdc.approve(address(p), amt);
        p.buy(side, amt, ref, 0);
        vm.stopPrank();
    }

    function _settle(TifoPromo p, TifoPromo.Outcome o) internal {
        vm.warp(kickoff + 2 hours);
        vm.prank(agent);
        p.proposeResult(o, bytes32("e"));
        vm.warp(block.timestamp + 16 minutes);
        p.finalize();
        p.payRefunds(100);
        p.releaseRemainder();
    }

    // ------------------------------------------------------------ price

    function test_orderBelowPrice_isRefused() public {
        TifoPromo p = _drop(50e6, 5000, 0, 0, 0, 5e6);
        address u = makeAddr("u");
        usdc.mint(u, 5e6);
        vm.startPrank(u);
        usdc.approve(address(p), 5e6);
        vm.expectRevert(TifoPromo.BelowPrice.selector);
        p.buy(0, 1, bytes32("slot-1"), 0);
        p.buy(0, 5e6, bytes32("slot-1"), 0); // the full price takes the slot
        vm.stopPrank();
        assertTrue(p.usedRef(bytes32("slot-1")));
    }

    function test_dustCannotSwitchTheOfferOn() public {
        TifoPromo p = _drop(50e6, 10000, 0, 0, 3, 2e6);
        for (uint160 i = 1; i <= 3; i++) {
            address u = address(0xD000 + i);
            usdc.mint(u, 1);
            vm.startPrank(u);
            usdc.approve(address(p), 1);
            vm.expectRevert(TifoPromo.BelowPrice.selector);
            p.buy(0, 1, bytes32(0), 0);
            vm.stopPrank();
        }
        assertFalse(p.offerOn());
    }

    // ------------------------------------------------------------ physical orders never sent

    function test_unsentFreeOrder_buyerGetsEverythingBack_evenIfTheirTeamLoses() public {
        TifoPromo p = _drop(100e6, 10000, 0, 7 days, 0, 0);
        address buyer = makeAddr("buyer");
        _buy(p, buyer, 0, 20e6, bytes32("o1"));
        vm.warp(kickoff + 8 days);
        p.refundUnsent(0);
        assertEq(usdc.balanceOf(buyer), 20e6);
        _settle(p, TifoPromo.Outcome.B);
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(usdc.balanceOf(address(p)), 0);
    }

    function test_unsentOrder_afterItsRebateWasPaid_getsTheRestBack() public {
        TifoPromo p = _drop(100e6, 5000, 0, 30 days, 0, 0);
        address buyer = makeAddr("buyer");
        _buy(p, buyer, 0, 20e6, bytes32("o1"));
        _settle(p, TifoPromo.Outcome.A); // $10 back for the win
        assertEq(usdc.balanceOf(buyer), 10e6);
        vm.warp(block.timestamp + 30 days);
        p.refundUnsent(0); // never sent: the other $10 comes back too, never more
        assertEq(usdc.balanceOf(buyer), 20e6);
        assertEq(usdc.balanceOf(address(p)), 0);
    }

    function test_unsentOrderBeforeKickoff_freesTheBudgetForTheNextBuyer() public {
        TifoPromo p = _drop(10e6, 10000, 0, 1 hours, 0, 0);
        _buy(p, makeAddr("a"), 0, 10e6, bytes32("o1"));
        vm.warp(block.timestamp + 1 hours);
        p.refundUnsent(0);
        assertEq(p.liability(0), 0);
        address b = makeAddr("b");
        _buy(p, b, 0, 10e6, bytes32("o2"));
        (, , , , , , uint16 rate, , ) = _order(p, 1);
        assertEq(rate, 10000); // the free offer is back for the next fan
    }

    function _order(TifoPromo p, uint256 i) internal view returns (address, uint8, uint256, uint16, uint16, uint64, uint16, uint16, uint64) {
        TifoPromo.Order memory o = p.getOrders(i, 1)[0];
        return (o.buyer, o.side, o.amount, o.rateBps, o.drawBps, o.at, o.rateBps, o.drawBps, o.at);
    }

    function test_deliveredOrder_paysTheSellerAndTheRebateMoneyAfterFullTime() public {
        TifoPromo p = _drop(100e6, 5000, 500, 30 days, 0, 0);
        address buyer = makeAddr("buyer");
        _buy(p, buyer, 1, 20e6, bytes32("o1"));
        assertEq(p.reserve(), 10e6);
        _settle(p, TifoPromo.Outcome.A); // their team lost
        assertEq(usdc.balanceOf(seller), 0); // nothing until delivery
        vm.prank(buyer);
        p.confirmReceived(0);
        assertEq(usdc.balanceOf(seller), 20e6);
        assertEq(usdc.balanceOf(address(p)), 0);
    }

    /// Random physical orders, random deliveries and non-deliveries, any result: the drop always holds exactly what it
    /// still owes, an unsent order always comes back whole, and nothing is left at the end.
    function testFuzz_physicalDrop_balancesAndUnsentAreWhole(uint256 seed, uint8 n, uint8 outcomeSeed) public {
        n = uint8(bound(n, 1, 12));
        TifoPromo p = _drop(60e6, 5000, 500, 3 days, 0, 0);
        uint256[] memory amt = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            amt[i] = bound(uint256(keccak256(abi.encode(seed, i))), 1e6, 40e6);
            _buy(p, address(uint160(0xA000 + i)), uint8(uint256(keccak256(abi.encode(seed, i, "s"))) % 2), amt[i], bytes32(i + 1));
        }
        // some are sent and confirmed before kickoff, some never sent
        for (uint256 i = 0; i < n; i++) {
            if (uint256(keccak256(abi.encode(seed, i, "d"))) % 3 == 0) {
                vm.prank(seller);
                p.markSent(i, "x");
                vm.prank(address(uint160(0xA000 + i)));
                p.confirmReceived(i);
            }
        }
        assertEq(usdc.balanceOf(address(p)), p.reserve() + p.escrowed());
        TifoPromo.Outcome o = TifoPromo.Outcome(1 + (outcomeSeed % 3));
        _settle(p, o);
        assertEq(usdc.balanceOf(address(p)), p.reserve() + p.escrowed());
        vm.warp(block.timestamp + 4 days);
        for (uint256 i = 0; i < n; i++) {
            TifoPromo.Shipment[] memory s = p.getShipments(i, 1);
            if (s[0].state != TifoPromo.Delivery.Held) continue;
            address u = address(uint160(0xA000 + i));
            p.refundUnsent(i);
            assertEq(usdc.balanceOf(u), amt[i]); // whole, whatever the result, rebate included
        }
        assertEq(usdc.balanceOf(address(p)), 0);
        assertEq(p.reserve(), 0);
        assertEq(p.pendingReserved(), 0);
    }

    // ------------------------------------------------------------ result

    function test_agentCannotProposeTwice() public {
        TifoPromo p = _drop(50e6, 5000, 0, 0, 0, 0);
        vm.warp(kickoff + 3 hours);
        vm.prank(agent);
        p.proposeResult(TifoPromo.Outcome.A, 0);
        vm.warp(block.timestamp + 14 minutes);
        vm.prank(agent);
        vm.expectRevert(TifoPromo.AlreadyProposed.selector);
        p.proposeResult(TifoPromo.Outcome.B, 0);
        // the operator can still correct it inside the window
        vm.prank(operator);
        p.correctResult(TifoPromo.Outcome.B, 0);
        assertEq(uint8(p.finalOutcome()), uint8(TifoPromo.Outcome.B));
    }

    // ------------------------------------------------------------ blocked wallet

    function test_blockedWinner_doesNotStopOtherRefunds_andCanClaimLater() public {
        TifoPromo p = _drop(50e6, 5000, 0, 0, 0, 0);
        address a = makeAddr("a");
        address b = makeAddr("b");
        _buy(p, a, 0, 10e6, bytes32("1"));
        _buy(p, b, 0, 10e6, bytes32("2"));
        usdc.block_(a);
        _settle(p, TifoPromo.Outcome.A);
        assertEq(usdc.balanceOf(b), 5e6);
        assertEq(p.owed(a), 5e6);
        assertEq(usdc.balanceOf(address(p)), 5e6); // only what a is owed
        usdc.block_(address(0));
        vm.prank(a);
        p.claim();
        assertEq(usdc.balanceOf(a), 5e6);
        assertEq(usdc.balanceOf(address(p)), 0);
    }
}
