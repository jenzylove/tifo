// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TifoPromo} from "../src/TifoPromo.sol";
import {TifoFactory} from "../src/TifoFactory.sol";

contract MockUSDC {
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address s, uint256 amt) external returns (bool) {
        allowance[msg.sender][s] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external virtual returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address f, address to, uint256 amt) external returns (bool) {
        allowance[f][msg.sender] -= amt;
        balanceOf[f] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

contract TifoPromoTest is Test {
    MockUSDC usdc;
    TifoFactory factory;
    TifoPromo promo;
    address seller = makeAddr("seller");
    address agent = makeAddr("agent");
    address operator = makeAddr("operator");
    address a1 = makeAddr("a1");
    address a2 = makeAddr("a2");
    address b1 = makeAddr("b1");
    uint64 kickoff;

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        factory = new TifoFactory(address(usdc), agent, operator);
        kickoff = uint64(block.timestamp + 1 days);
        vm.prank(seller);
        promo = TifoPromo(factory.createPromo(keccak256("epl-mnu-tot-2026-10-10"), kickoff, kickoff + 105 minutes, 100e6, 500, 6000, 3000, 4000, 0, 0, 0, 0, 0, "{}"));
        for (uint256 i; i < 3; i++) {
            address u = [a1, a2, b1][i];
            usdc.mint(u, 1_000e6);
            vm.prank(u);
            usdc.approve(address(promo), type(uint256).max);
        }
    }

    function _buy(address u, uint8 side, uint256 amt) internal {
        vm.prank(u);
        promo.buy(side, amt, bytes32(0), 0);
    }

    function test_holdsOnlyTheIncreaseAndForwardsTheRest() public {
        _buy(a1, 0, 50e6); // A bill 15
        assertEq(usdc.balanceOf(address(promo)), 15e6);
        assertEq(usdc.balanceOf(seller), 35e6);
        _buy(b1, 1, 30e6); // B bill 12, max still 15
        assertEq(usdc.balanceOf(address(promo)), 15e6);
        assertEq(usdc.balanceOf(seller), 65e6);
    }

    function test_oneSidePerWallet_andCap() public {
        _buy(a1, 0, 50e6);
        vm.prank(a1);
        vm.expectRevert(TifoPromo.OneSidePerWallet.selector);
        promo.buy(1, 1e6, bytes32(0), 0);
        // +90 would take the bill to 105 > 100. A buyer who insists on the 30% offer is refused...
        vm.prank(a2);
        vm.expectRevert(TifoPromo.OfferGone.selector);
        promo.buy(0, 300e6, bytes32(0), 3000);
        // ...and one who accepts whatever is left buys with no rebate, so the bill stays under the cap.
        vm.prank(a2);
        promo.buy(0, 300e6, bytes32(0), 0);
        (, , uint256 la, , uint256 r, , ) = promo.book();
        assertEq(la, 15e6);
        assertEq(r, 15e6);
    }

    function test_agentCannotMoveFundsOrBreakBounds() public {
        _buy(a1, 0, 50e6);
        vm.prank(agent);
        vm.expectRevert(TifoPromo.RateOutOfBounds.selector);
        promo.setRates(100, 3000, "x");
        vm.prank(seller);
        vm.expectRevert(TifoPromo.NotAgent.selector);
        promo.setRates(3000, 3000, "x");
        // a rate change applies only to future orders
        vm.prank(agent);
        promo.setRates(1000, 5000, "x");
        (, , , uint16 locked, , ) = promo.orders(0);
        assertEq(locked, 3000);
    }

    function test_noOrdersAfterKickoff() public {
        vm.warp(kickoff);
        vm.prank(a1);
        vm.expectRevert(TifoPromo.Closed.selector);
        promo.buy(0, 10e6, bytes32(0), 0);
    }

    function test_fullFlow_Bwins_refundsAndRemainder() public {
        _buy(a1, 0, 50e6); // A: 15
        _buy(b1, 1, 30e6); // B: 12
        vm.warp(kickoff + 30 minutes);
        vm.prank(agent);
        vm.expectRevert(TifoPromo.TooEarly.selector);
        promo.proposeResult(TifoPromo.Outcome.B, keccak256("espn+tsdb"));
        vm.warp(kickoff + 2 hours);
        vm.prank(agent);
        promo.proposeResult(TifoPromo.Outcome.B, keccak256("espn+tsdb"));
        vm.expectRevert(TifoPromo.TooEarly.selector);
        promo.finalize();
        vm.warp(block.timestamp + 15 minutes);
        promo.finalize();
        uint256 before = usdc.balanceOf(b1);
        promo.payRefunds(50);
        assertEq(usdc.balanceOf(b1) - before, 12e6);
        promo.releaseRemainder();
        assertEq(usdc.balanceOf(seller), 35e6 + 30e6 + 3e6);
        assertEq(usdc.balanceOf(address(promo)), 0);
        assertEq(promo.refundedTotal(), 12e6);
        TifoPromo.Entry[] memory j = promo.getJournal(0, 10);
        assertEq(j.length, 3); // proposed, final, remainder
        assertEq(j[0].kind, "proposed");
        assertEq(j[1].text, "B");
        assertEq(promo.getOrders(0, 10).length, 2);
        TifoFactory.PromoInfo[] memory infos = factory.getPromos(0, 10);
        assertEq(infos.length, 1);
        assertEq(infos[0].seller, seller);
    }

    function test_operatorCorrectsWrongProposal_sellerCannot() public {
        _buy(a1, 0, 50e6);
        vm.warp(kickoff + 2 hours);
        vm.prank(agent);
        promo.proposeResult(TifoPromo.Outcome.Draw, bytes32(0));
        vm.prank(seller);
        vm.expectRevert(TifoPromo.NotOperator.selector);
        promo.correctResult(TifoPromo.Outcome.Draw, bytes32(0));
        vm.prank(operator);
        promo.correctResult(TifoPromo.Outcome.A, keccak256("fixed"));
        promo.payRefunds(10);
        assertEq(usdc.balanceOf(a1), 1_000e6 - 50e6 + 15e6);
    }

    function test_abandonedPromoVoidsAndReturnsReserve() public {
        _buy(a1, 0, 50e6);
        vm.warp(kickoff + 3 days);
        promo.finalize();
        assertEq(uint8(promo.finalOutcome()), uint8(TifoPromo.Outcome.Void));
        promo.releaseRemainder();
        assertEq(usdc.balanceOf(seller), 50e6);
    }
}

contract Handler is Test {
    TifoPromo public promo;
    MockUSDC public usdc;
    address public agent;
    uint256 public paidIn;
    uint256 public toSeller;
    address seller;

    constructor(TifoPromo p, MockUSDC u, address a, address s) {
        promo = p;
        usdc = u;
        agent = a;
        seller = s;
    }

    function buy(uint256 who, uint8 side, uint256 amt) external {
        side = side % 2;
        amt = bound(amt, 1e6, 80e6);
        address u = address(uint160(uint256(keccak256(abi.encode(who % 200, side)))));
        usdc.mint(u, amt);
        vm.startPrank(u);
        usdc.approve(address(promo), amt);
        uint256 sb = usdc.balanceOf(seller);
        try promo.buy(side, amt, bytes32(0), 0) {
            paidIn += amt;
            toSeller += usdc.balanceOf(seller) - sb;
        } catch {}
        vm.stopPrank();
    }

    function setRates(uint16 ra, uint16 rb) external {
        ra = uint16(bound(ra, 500, 6000));
        rb = uint16(bound(rb, 500, 6000));
        vm.prank(agent);
        promo.setRates(ra, rb, "fuzz");
    }
}

contract TifoPromoInvariant is Test {
    MockUSDC usdc;
    TifoPromo promo;
    Handler handler;
    address seller = makeAddr("seller");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        address agent = makeAddr("agent");
        promo = new TifoPromo(address(usdc), seller, agent, makeAddr("op"), bytes32(0), uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days), 250e6, 500, 6000, 2000, 4000, 300, 500, 0, 0, 0);
        handler = new Handler(promo, usdc, agent, seller);
        targetContract(address(handler));
    }

    /// The contract always holds exactly the largest of the three bills (A wins, B wins, draw), never more than the cap,
    /// and every dollar paid in is either with the seller or in reserve.
    function invariant_reserveCoversEitherResult() public view {
        (, , uint256 la, uint256 lb, uint256 r, uint256 cap, ) = promo.book();
        uint256 dl = promo.drawLiability();
        uint256 top = la > lb ? la : lb;
        assertEq(r, dl > top ? dl : top);
        assertLe(r, cap);
        assertEq(usdc.balanceOf(address(promo)), r);
        assertEq(handler.paidIn(), handler.toSeller() + r);
    }
}

contract PermitUSDC is MockUSDC {
    // Minimal permit: trusts (v,r,s) = signature from `owner` via ecrecover over a simple digest.
    bytes32 public constant TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    mapping(address => uint256) public nonces;

    function digest(address owner, address spender, uint256 value, uint256 nonce, uint256 deadline) public pure returns (bytes32) {
        return keccak256(abi.encode(TYPEHASH, owner, spender, value, nonce, deadline));
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        require(block.timestamp <= deadline, "expired");
        require(ecrecover(digest(owner, spender, value, nonces[owner]++, deadline), v, r, s) == owner, "sig");
        allowance[owner][spender] = value;
    }
}

contract TifoPermitTest is Test {
    function test_gaslessBuy_onlyPullsFromSigner() public {
        vm.warp(1_000_000);
        PermitUSDC usdc = new PermitUSDC();
        address seller = makeAddr("seller");
        TifoPromo promo = new TifoPromo(address(usdc), seller, makeAddr("agent"), makeAddr("op"), bytes32(0), uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days), 100e6, 500, 6000, 3000, 4000, 0, 0, 0, 0, 0);
        (address fan, uint256 pk) = makeAddrAndKey("fan");
        usdc.mint(fan, 20e6);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, usdc.digest(fan, address(promo), 20e6, 0, deadline));
        // only the agent's relayer may submit: the permit does not cover the side or the order reference
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(TifoPromo.NotAgent.selector);
        promo.buyWithPermit(fan, 1, 20e6, bytes32("other"), 0, deadline, v, r, s);
        address relayer = makeAddr("agent");
        vm.prank(relayer);
        promo.buyWithPermit(fan, 0, 20e6, bytes32("order-1"), 0, deadline, v, r, s);
        assertEq(usdc.balanceOf(fan), 0);
        assertEq(usdc.balanceOf(seller), 14e6); // 20 - 6 held
        assertEq(promo.sideOf(fan), 1);
        // a relayer can't make someone else pay without their signature
        address victim = makeAddr("victim");
        usdc.mint(victim, 20e6);
        vm.prank(relayer);
        vm.expectRevert();
        promo.buyWithPermit(victim, 0, 20e6, bytes32(0), 0, deadline, v, r, s);
    }
}
