// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TifoPromo} from "./TifoPromo.sol";

/// @notice Sellers open promos here. The seller is always msg.sender, so a promo can only
/// forward money to the wallet that created it. Agent and operator are fixed at deploy.
contract TifoFactory {
    address public immutable usdc;
    address public immutable agent;
    address public immutable operator;
    address[] public promos;

    /// @param meta JSON: fixture slug, team names, shop name, products. Lets the app list promos from chain alone.
    event PromoCreated(address indexed promo, address indexed seller, bytes32 indexed fixtureId, uint64 closesAt, uint256 cap, string meta);

    constructor(address usdc_, address agent_, address operator_) {
        usdc = usdc_;
        agent = agent_;
        operator = operator_;
    }

    function createPromo(
        bytes32 fixtureId,
        uint64 closesAt,
        uint64 settleNotBefore,
        uint256 cap,
        uint16 minBps,
        uint16 maxBps,
        uint16 rateA,
        uint16 rateB,
        string calldata meta
    ) external returns (address promo) {
        require(closesAt > block.timestamp, "kickoff passed");
        promo = address(
            new TifoPromo(usdc, msg.sender, agent, operator, fixtureId, closesAt, settleNotBefore, cap, minBps, maxBps, rateA, rateB)
        );
        promos.push(promo);
        emit PromoCreated(promo, msg.sender, fixtureId, closesAt, cap, meta);
    }

    function promosCount() external view returns (uint256) {
        return promos.length;
    }
}
