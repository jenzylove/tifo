// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TifoShops} from "../src/TifoShops.sol";

contract DeployShops is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        TifoShops s = new TifoShops();
        vm.stopBroadcast();
        console.log("TifoShops", address(s));
    }
}
