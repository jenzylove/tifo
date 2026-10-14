// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TifoPromo} from "../src/TifoPromo.sol";
import {TifoFactory} from "../src/TifoFactory.sol";
import {TifoAccount} from "../src/TifoAccount.sol";
import {MockUSDC} from "./TifoPromo.t.sol";

/// The seller's money leaves the account without a person in between: the agent can send the balance to the payout
/// wallet the owner chose, and nowhere else. A new seller gets the account and the first drop in one step.
contract TifoPayoutTest is Test {
    MockUSDC usdc;
    TifoFactory factory;
    address seller = makeAddr("seller");
    address bank = makeAddr("sellers payout wallet");
    address agent = makeAddr("agent");
    address operator = makeAddr("operator");
    address stranger = makeAddr("stranger");
    uint64 kickoff;

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        factory = new TifoFactory(address(usdc), agent, operator);
        kickoff = uint64(block.timestamp + 1 days);
    }

    /// 50% back for every buyer, $40 at most.
    function _terms(uint256 cap) internal view returns (TifoAccount.Terms memory) {
        return TifoAccount.Terms(bytes32("m"), kickoff, kickoff + 105 minutes, cap, 5000, 5000, 5000, 5000, 0, 500, 0, 0);
    }

    function _fan(uint256 i, TifoPromo promo, uint8 side, uint256 amt) internal returns (address u) {
        u = address(uint160(0xF000 + i));
        usdc.mint(u, amt);
        vm.startPrank(u);
        usdc.approve(address(promo), amt);
        promo.buy(side, amt, bytes32(i), 0);
        vm.stopPrank();
    }

    function test_payout_defaultsToTheOwner_andOnlyTheOwnerCanChangeIt() public {
        vm.prank(seller);
        TifoAccount acct = TifoAccount(factory.createAccount(0, 50e6, 40e6, address(0)));
        assertEq(acct.payout(), seller);

        vm.prank(agent);
        vm.expectRevert(TifoAccount.NotOwner.selector);
        acct.setPayout(agent);
        vm.prank(seller);
        acct.setPayout(bank);
        assertEq(acct.payout(), bank);
    }

    function test_payout_agentSendsTheBalanceToThePayoutWalletAndNowhereElse() public {
        vm.prank(seller);
        TifoAccount acct = TifoAccount(factory.createAccount(0, 50e6, 40e6, bank));
        vm.prank(agent);
        TifoPromo promo = TifoPromo(acct.openDeal(_terms(40e6), "{}", "first drop"));

        // Nothing to pay yet: no transfer, no record.
        vm.prank(agent);
        assertEq(acct.payOut("nothing yet"), 0);
        assertEq(acct.payoutsCount(), 0);

        // A $20 sale at 50% back: $10 stays in the drop for the refund, $10 reaches the account.
        address fan = _fan(1, promo, 0, 20e6);
        assertEq(usdc.balanceOf(address(acct)), 10e6);
        assertEq(usdc.balanceOf(address(promo)), 10e6);

        vm.prank(stranger);
        vm.expectRevert(TifoAccount.NotAgent.selector);
        acct.payOut("mine now");

        vm.prank(agent);
        assertEq(acct.payOut("sale of $20: $10 held in the drop for the refund, $10 sent to you"), 10e6);
        assertEq(usdc.balanceOf(bank), 10e6);
        assertEq(usdc.balanceOf(agent), 0);
        assertEq(usdc.balanceOf(address(acct)), 0);
        assertEq(acct.paidOutTotal(), 10e6);

        TifoAccount.Payout[] memory ps = acct.getPayouts(0, 10);
        assertEq(ps.length, 1);
        assertEq(ps[0].to, bank);
        assertEq(ps[0].amount, 10e6);
        assertEq(ps[0].reason, "sale of $20: $10 held in the drop for the refund, $10 sent to you");

        // The payout took nothing from the refund: the fan's team wins and the fan is paid from the drop.
        vm.warp(kickoff + 2 hours);
        vm.prank(agent);
        promo.proposeResult(TifoPromo.Outcome.A, bytes32("evidence"));
        vm.warp(block.timestamp + 16 minutes);
        promo.finalize();
        promo.payRefunds(200);
        promo.releaseRemainder();
        assertEq(usdc.balanceOf(fan), 10e6);
        assertEq(usdc.balanceOf(address(promo)), 0);
    }

    function test_payout_whatIsLeftAfterFullTimeIsPaidOutToo() public {
        vm.prank(seller);
        TifoAccount acct = TifoAccount(factory.createAccount(0, 50e6, 40e6, bank));
        vm.prank(agent);
        TifoPromo promo = TifoPromo(acct.openDeal(_terms(40e6), "{}", "first drop"));
        _fan(1, promo, 0, 20e6);
        vm.prank(agent);
        acct.payOut("at the sale");

        // The fan's team loses, so the $10 held for the refund comes back to the account, and on to the seller.
        vm.warp(kickoff + 2 hours);
        vm.prank(agent);
        promo.proposeResult(TifoPromo.Outcome.B, bytes32("evidence"));
        vm.warp(block.timestamp + 16 minutes);
        promo.finalize();
        promo.payRefunds(200);
        promo.releaseRemainder();
        assertEq(usdc.balanceOf(address(acct)), 10e6);
        vm.prank(seller); // the owner can trigger it as well
        acct.payOut("after full time");
        assertEq(usdc.balanceOf(bank), 20e6);
        assertEq(acct.payoutsCount(), 2);
        assertEq(acct.paidOutTotal(), 20e6);
    }

    function test_firstDrop_accountAndDropInOneStep() public {
        vm.prank(seller);
        (address a, address p) = factory.createAccountAndOpen(1000, 50e6, 40e6, bank, _terms(30e6), "{\"shop\":\"Ada\"}");
        TifoAccount acct = TifoAccount(a);
        assertEq(factory.accountOf(seller), a);
        assertEq(acct.owner(), seller);
        assertEq(acct.payout(), bank);
        assertEq(TifoPromo(p).seller(), a);
        assertEq(acct.committed(), 30e6);

        TifoAccount.Deal[] memory ds = acct.getDeals(0, 10);
        assertEq(ds.length, 1);
        assertEq(ds[0].promo, p);
        assertFalse(ds[0].byAgent); // the seller opened this one

        // The shortcut cannot be reused or called by anyone but the factory.
        vm.prank(seller);
        vm.expectRevert(bytes("exists"));
        factory.createAccountAndOpen(1000, 50e6, 40e6, bank, _terms(5e6), "{}");
        vm.prank(seller);
        vm.expectRevert(TifoAccount.NotFactory.selector);
        acct.openFirst(_terms(5e6), "{}");
        vm.prank(agent);
        vm.expectRevert(TifoAccount.NotFactory.selector);
        acct.openFirst(_terms(5e6), "{}");
    }

    function test_deals_recordWhoDecidedAndWhy() public {
        vm.prank(seller);
        TifoAccount acct = TifoAccount(factory.createAccount(0, 50e6, 40e6, address(0)));
        vm.startPrank(agent);
        acct.openDeal(_terms(30e6), "{}", "big match, inside your limit");
        uint256 id = acct.propose(_terms(35e6), "{}", "worth going over the limit for");
        vm.stopPrank();
        vm.prank(seller);
        acct.decide(id, true);

        TifoAccount.Deal[] memory ds = acct.getDeals(0, 10);
        assertEq(ds.length, 2);
        assertTrue(ds[0].byAgent);
        assertEq(ds[0].reason, "big match, inside your limit");
        assertFalse(ds[1].byAgent); // the seller approved this one
        assertEq(ds[1].reason, "worth going over the limit for");
    }
}
