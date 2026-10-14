// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TifoPromo} from "../src/TifoPromo.sol";
import {TifoFactory} from "../src/TifoFactory.sol";
import {TifoAccount} from "../src/TifoAccount.sol";
import {MockUSDC} from "./TifoPromo.t.sol";

/// Physical products: the seller's share waits in the drop until the buyer has the product.
contract TifoDeliveryTest is Test {
    MockUSDC usdc;
    TifoFactory factory;
    address seller = makeAddr("seller");
    address agent = makeAddr("agent");
    address operator = makeAddr("operator");
    address stranger = makeAddr("stranger");
    uint64 kickoff;
    uint32 constant HOLD = 7 days;

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        factory = new TifoFactory(address(usdc), agent, operator);
        kickoff = uint64(block.timestamp + 1 days);
    }

    function _drop(uint32 hold) internal returns (TifoPromo p) {
        vm.prank(seller);
        // $10 budget, 50% back: the seller's share of a $10 sale is $5 once the first buyer's $5 reserve is held.
        p = TifoPromo(factory.createPromo(bytes32("m"), kickoff, kickoff + 105 minutes, 10e6, 5000, 5000, 5000, 5000, 0, 0, hold, 0, "{}"));
    }

    function _buy(TifoPromo p, uint256 i, uint8 side, uint256 amt) internal returns (address u) {
        u = address(uint160(0xB000 + i));
        usdc.mint(u, amt);
        vm.startPrank(u);
        usdc.approve(address(p), amt);
        p.buy(side, amt, bytes32(i), 0);
        vm.stopPrank();
    }

    function _held(TifoPromo p, uint256 i) internal view returns (TifoPromo.Delivery state, uint256 held, string memory tracking) {
        TifoPromo.Shipment[] memory s = p.getShipments(i, 1);
        return (s[0].state, s[0].held, s[0].tracking);
    }

    function test_digitalDropPaysSellerAtSale() public {
        TifoPromo p = _drop(0);
        _buy(p, 1, 0, 10e6);
        assertEq(usdc.balanceOf(seller), 5e6); // $10 sale minus the $5 refund reserve
        assertEq(p.escrowed(), 0);
        (TifoPromo.Delivery st,,) = _held(p, 0);
        assertEq(uint8(st), uint8(TifoPromo.Delivery.None));
    }

    function test_physicalDropHoldsUntilBuyerConfirms() public {
        TifoPromo p = _drop(HOLD);
        address buyer = _buy(p, 1, 0, 10e6);
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(p.escrowed(), 5e6);

        vm.prank(seller);
        p.markSent(0, "Chowdeck CHW-123");
        (TifoPromo.Delivery st,, string memory tr) = _held(p, 0);
        assertEq(uint8(st), uint8(TifoPromo.Delivery.Sent));
        assertEq(tr, "Chowdeck CHW-123");

        vm.prank(buyer);
        p.confirmReceived(0);
        assertEq(usdc.balanceOf(seller), 5e6);
        assertEq(p.escrowed(), 0);
    }

    function test_onlySellerMarksSent_onlyBuyerConfirms() public {
        TifoPromo p = _drop(HOLD);
        _buy(p, 1, 0, 10e6);
        vm.prank(stranger);
        vm.expectRevert(TifoPromo.NotSeller.selector);
        p.markSent(0, "fake");
        vm.prank(stranger);
        vm.expectRevert(TifoPromo.NotBuyer.selector);
        p.confirmReceived(0);
        vm.prank(seller);
        vm.expectRevert(TifoPromo.NotBuyer.selector);
        p.confirmReceived(0); // the seller cannot confirm their own delivery
    }

    function test_autoReleaseAfterWindowWithNoDispute() public {
        TifoPromo p = _drop(HOLD);
        _buy(p, 1, 0, 10e6);
        vm.prank(seller);
        p.markSent(0, "GIG 998");
        vm.warp(block.timestamp + HOLD - 1);
        vm.expectRevert(TifoPromo.TooEarly.selector);
        p.release(0);
        vm.warp(block.timestamp + 1);
        vm.prank(stranger); // anyone, usually the agent
        p.release(0);
        assertEq(usdc.balanceOf(seller), 5e6);
    }

    function test_buyerGetsMoneyBackIfNeverSent() public {
        TifoPromo p = _drop(HOLD);
        address buyer = _buy(p, 1, 0, 10e6);
        vm.expectRevert(TifoPromo.TooEarly.selector);
        p.refundUnsent(0);
        vm.warp(block.timestamp + HOLD);
        p.refundUnsent(0);
        assertEq(usdc.balanceOf(buyer), 5e6);
        assertEq(usdc.balanceOf(seller), 0);
        // and it cannot be marked sent or paid out afterwards
        vm.prank(seller);
        vm.expectRevert(TifoPromo.BadState.selector);
        p.markSent(0, "late");
    }

    function test_disputeGoesToOperator() public {
        TifoPromo p = _drop(HOLD);
        address buyer = _buy(p, 1, 0, 10e6);
        vm.prank(seller);
        p.markSent(0, "rider 0803");
        vm.prank(buyer);
        p.dispute(0);
        vm.warp(block.timestamp + HOLD + 1);
        vm.expectRevert(TifoPromo.TooEarly.selector);
        p.release(0); // a disputed order never auto-releases
        vm.prank(seller);
        vm.expectRevert(TifoPromo.NotOperator.selector);
        p.resolveDispute(0, false);
        vm.prank(operator);
        p.resolveDispute(0, true);
        assertEq(usdc.balanceOf(buyer), 5e6);
    }

    function test_escrowDoesNotTouchRefundsOrRemainder() public {
        TifoPromo p = _drop(HOLD);
        address a = _buy(p, 1, 0, 10e6); // A fan
        _buy(p, 2, 1, 10e6); // B fan
        // reserve = $5 (largest bill), escrow = the rest of $20
        assertEq(p.reserve(), 5e6);
        assertEq(p.escrowed(), 15e6);
        assertEq(usdc.balanceOf(address(p)), 20e6);
        vm.warp(kickoff + 2 hours);
        vm.prank(agent);
        p.proposeResult(TifoPromo.Outcome.A, bytes32("e"));
        vm.warp(block.timestamp + 16 minutes);
        p.finalize();
        p.payRefunds(10);
        p.releaseRemainder();
        assertEq(usdc.balanceOf(a), 5e6); // 50% back
        assertEq(usdc.balanceOf(address(p)), 15e6); // only the held deliveries remain
        assertEq(p.escrowed(), 15e6);
    }

    function test_accountOwnerCanMarkSent() public {
        vm.prank(seller);
        TifoAccount acct = TifoAccount(factory.createAccount(0, 100e6, 50e6, address(0)));
        vm.prank(seller);
        TifoPromo p = TifoPromo(
            acct.open(TifoAccount.Terms(bytes32("m"), kickoff, kickoff + 105 minutes, 10e6, 5000, 5000, 5000, 5000, 0, 0, HOLD, 0), "{}")
        );
        address buyer = _buy(p, 1, 0, 10e6);
        vm.prank(seller); // the person behind the account, not the account contract
        p.markSent(0, "Zaddy Express 55");
        vm.prank(buyer);
        p.confirmReceived(0);
        assertEq(usdc.balanceOf(address(acct)), 5e6);
    }

    function test_holdIsCapped() public {
        vm.prank(seller);
        vm.expectRevert(bytes("hold"));
        factory.createPromo(bytes32("m"), kickoff, kickoff + 105 minutes, 10e6, 5000, 5000, 5000, 5000, 0, 0, 31 days, 0, "{}");
    }
}
