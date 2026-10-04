// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TifoShops} from "../src/TifoShops.sol";

contract TifoShopsTest is Test {
    TifoShops shops = new TifoShops();
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function test_saveAndRename() public {
        vm.prank(alice);
        shops.save("ada-skincare", '{"name":"Ada"}');
        assertEq(shops.shopByHandle("ada-skincare").owner, alice);
        vm.prank(alice);
        shops.save("ada-glow", '{"name":"Ada Glow"}');
        assertEq(shops.shopByHandle("ada-skincare").owner, address(0));
        assertEq(shops.shopOf(alice).profile, '{"name":"Ada Glow"}');
        assertEq(shops.shopsCount(), 1);
        // the old handle is free again
        vm.prank(bob);
        shops.save("ada-skincare", "{}");
        assertEq(shops.shopByHandle("ada-skincare").owner, bob);
    }

    function test_handleTakenAndBadHandles() public {
        vm.prank(alice);
        shops.save("kits", "{}");
        vm.prank(bob);
        vm.expectRevert(TifoShops.HandleTaken.selector);
        shops.save("kits", "{}");
        string[4] memory bad = ["ab", "Kits", "-kits", "kits shop"];
        for (uint256 i; i < bad.length; i++) {
            vm.prank(bob);
            vm.expectRevert(TifoShops.BadHandle.selector);
            shops.save(bad[i], "{}");
        }
    }
}
