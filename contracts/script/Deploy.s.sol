// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TifoFactory} from "../src/TifoFactory.sol";

contract Deploy is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address agent = vm.envAddress("AGENT_ADDRESS");
        address operator = vm.envAddress("OPERATOR_ADDRESS");
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        TifoFactory f = new TifoFactory(usdc, agent, operator);
        vm.stopBroadcast();
        console.log("TifoFactory", address(f));
    }
}
