// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TifoFloat} from "../src/TifoFloat.sol";
import {MockUSDC} from "./TifoPromo.t.sol";

contract TifoFloatTest is Test {
    MockUSDC usdc;
    TifoFloat flt;
    address owner = makeAddr("owner");
    address releaser = makeAddr("releaser");
    address buyer = makeAddr("buyer");
    address other = makeAddr("other");
    uint256 constant PER_RELEASE = 50e6;
    uint256 constant PER_DAY = 120e6;

    event Released(bytes32 indexed ref, address indexed to, uint256 amount);

    function setUp() public {
        vm.warp(10 days + 3 hours); // inside a UTC day, not on its edge
        usdc = new MockUSDC();
        flt = new TifoFloat(address(usdc), owner, releaser, PER_RELEASE, PER_DAY);
        usdc.mint(address(flt), 1_000e6);
    }

    function ref(string memory id) internal pure returns (bytes32) {
        return keccak256(bytes(id));
    }

    // ---------------------------------------------------------- paying a buyer

    function test_releasePaysTheBuyerOnce() public {
        vm.expectEmit(true, true, false, true);
        emit Released(ref("chk_a"), buyer, 20e6);
        vm.prank(releaser);
        flt.release(ref("chk_a"), buyer, 20e6);
        assertEq(usdc.balanceOf(buyer), 20e6);
        assertEq(usdc.balanceOf(address(flt)), 980e6);
        assertTrue(flt.released(ref("chk_a")));
        assertFalse(flt.released(ref("chk_b")));
        assertEq(flt.releasedToday(), 20e6);
    }

    function test_theSameReferenceCannotBePaidTwice() public {
        vm.startPrank(releaser);
        flt.release(ref("chk_a"), buyer, 20e6);
        vm.expectRevert(TifoFloat.AlreadyReleased.selector);
        flt.release(ref("chk_a"), buyer, 20e6);
        // not even to another address or for another amount
        vm.expectRevert(TifoFloat.AlreadyReleased.selector);
        flt.release(ref("chk_a"), other, 1e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(buyer), 20e6);
        assertEq(usdc.balanceOf(other), 0);
        assertEq(flt.releasedToday(), 20e6);
    }

    function test_differentReferencesEachPay() public {
        vm.startPrank(releaser);
        flt.release(ref("chk_a"), buyer, 20e6);
        flt.release(ref("chk_b"), buyer, 30e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(buyer), 50e6);
    }

    function test_nothingIsPaidToNobodyOrForNothing() public {
        vm.startPrank(releaser);
        vm.expectRevert(bytes("bad release"));
        flt.release(ref("chk_a"), address(0), 1e6);
        vm.expectRevert(bytes("bad release"));
        flt.release(ref("chk_a"), buyer, 0);
        vm.stopPrank();
        assertFalse(flt.released(ref("chk_a"))); // a refused release does not burn the reference
    }

    // ----------------------------------------------------------------- limits

    function test_perReleaseLimit() public {
        vm.startPrank(releaser);
        flt.release(ref("chk_a"), buyer, PER_RELEASE); // exactly the limit is fine
        vm.expectRevert(TifoFloat.OverLimit.selector);
        flt.release(ref("chk_b"), buyer, PER_RELEASE + 1);
        vm.stopPrank();
        assertFalse(flt.released(ref("chk_b")));
    }

    function test_perDayLimit() public {
        vm.startPrank(releaser);
        flt.release(ref("chk_1"), buyer, 50e6);
        flt.release(ref("chk_2"), buyer, 50e6);
        flt.release(ref("chk_3"), buyer, 20e6); // 120 so far, exactly the limit
        assertEq(flt.releasedToday(), PER_DAY);
        vm.expectRevert(TifoFloat.OverLimit.selector);
        flt.release(ref("chk_4"), buyer, 1);
        vm.stopPrank();
        assertEq(usdc.balanceOf(buyer), PER_DAY);
        assertFalse(flt.released(ref("chk_4")));
    }

    function test_theDayWindowResets() public {
        vm.startPrank(releaser);
        flt.release(ref("chk_1"), buyer, 50e6);
        flt.release(ref("chk_2"), buyer, 50e6);
        flt.release(ref("chk_3"), buyer, 20e6);
        vm.expectRevert(TifoFloat.OverLimit.selector);
        flt.release(ref("chk_4"), buyer, 10e6);

        // the same UTC day, later: still full
        vm.warp(block.timestamp + 10 hours);
        assertEq(flt.releasedToday(), PER_DAY);
        vm.expectRevert(TifoFloat.OverLimit.selector);
        flt.release(ref("chk_4"), buyer, 10e6);

        // the next UTC day: the count starts again, and the refused reference can now be used
        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        assertEq(flt.releasedToday(), 0);
        flt.release(ref("chk_4"), buyer, 10e6);
        assertEq(flt.releasedToday(), 10e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(buyer), PER_DAY + 10e6);
    }

    function test_theDayEdgeIsMidnightUtc() public {
        vm.warp(20 days - 1);
        vm.startPrank(releaser);
        flt.release(ref("chk_1"), buyer, 50e6);
        flt.release(ref("chk_2"), buyer, 50e6);
        flt.release(ref("chk_3"), buyer, 20e6);
        vm.warp(20 days); // one second later
        flt.release(ref("chk_4"), buyer, 50e6);
        vm.stopPrank();
        assertEq(flt.releasedToday(), 50e6);
    }

    // ---------------------------------------------------------------- who can

    function test_onlyTheReleaserReleases() public {
        vm.prank(owner);
        vm.expectRevert(TifoFloat.NotReleaser.selector);
        flt.release(ref("chk_a"), buyer, 1e6);
        vm.prank(other);
        vm.expectRevert(TifoFloat.NotReleaser.selector);
        flt.release(ref("chk_a"), other, 1e6);
        vm.prank(buyer);
        vm.expectRevert(TifoFloat.NotReleaser.selector);
        flt.release(ref("chk_a"), buyer, 1e6);
        assertEq(usdc.balanceOf(buyer), 0);
    }

    function test_onlyTheOwnerWithdraws() public {
        vm.prank(releaser);
        vm.expectRevert(TifoFloat.NotOwner.selector);
        flt.withdraw(releaser, 1e6);
        vm.prank(other);
        vm.expectRevert(TifoFloat.NotOwner.selector);
        flt.withdraw(other, 1e6);

        vm.prank(owner);
        flt.withdraw(other, 400e6);
        assertEq(usdc.balanceOf(other), 400e6);
        assertEq(usdc.balanceOf(address(flt)), 600e6);
    }

    function test_onlyTheOwnerChangesLimits() public {
        vm.prank(releaser);
        vm.expectRevert(TifoFloat.NotOwner.selector);
        flt.setLimits(1_000e6, 1_000e6);
        vm.prank(other);
        vm.expectRevert(TifoFloat.NotOwner.selector);
        flt.setLimits(1_000e6, 1_000e6);

        vm.prank(owner);
        flt.setLimits(10e6, 15e6);
        assertEq(flt.perRelease(), 10e6);
        assertEq(flt.perDay(), 15e6);

        // the new ceiling applies at once
        vm.startPrank(releaser);
        vm.expectRevert(TifoFloat.OverLimit.selector);
        flt.release(ref("chk_a"), buyer, 11e6);
        flt.release(ref("chk_b"), buyer, 10e6);
        vm.expectRevert(TifoFloat.OverLimit.selector);
        flt.release(ref("chk_c"), buyer, 6e6);
        vm.stopPrank();
    }

    function test_onlyTheOwnerChangesTheReleaser() public {
        vm.prank(releaser);
        vm.expectRevert(TifoFloat.NotOwner.selector);
        flt.setReleaser(other);
        vm.prank(other);
        vm.expectRevert(TifoFloat.NotOwner.selector);
        flt.setReleaser(other);

        vm.prank(owner);
        flt.setReleaser(other);
        assertEq(flt.releaser(), other);

        // the old key is dead, the new one works
        vm.prank(releaser);
        vm.expectRevert(TifoFloat.NotReleaser.selector);
        flt.release(ref("chk_a"), buyer, 1e6);
        vm.prank(other);
        flt.release(ref("chk_a"), buyer, 1e6);
        assertEq(usdc.balanceOf(buyer), 1e6);
    }

    function test_releaserCannotBeSetToNobody() public {
        vm.prank(owner);
        vm.expectRevert(bytes("zero"));
        flt.setReleaser(address(0));
    }

    function test_releasedTodayStartsAtZero() public view {
        assertEq(flt.releasedToday(), 0);
    }
}
