// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TifoPromo} from "./TifoPromo.sol";
import {TifoAccount} from "./TifoAccount.sol";

/// @notice Creates seller accounts for the factory that deployed it. Split out so the factory stays under the
/// 24 KB contract size limit; only that factory can call it, and the account's owner is whoever called the factory.
contract TifoAccountDeployer {
    address public immutable factory;

    constructor() {
        factory = msg.sender;
    }

    function deploy(address usdc, address owner, address agent, uint16 weeklyBps, uint256 baseWeekly, uint256 perDealCap, address payout) external returns (address) {
        require(msg.sender == factory, "factory");
        return address(new TifoAccount(usdc, owner, agent, factory, weeklyBps, baseWeekly, perDealCap, payout));
    }
}

/// @notice Sellers open promos here. The seller is always msg.sender, so a promo can only
/// forward money to the wallet that created it. Agent and operator are fixed at deploy.
contract TifoFactory {
    address public immutable usdc;
    address public immutable agent;
    address public immutable operator;
    TifoAccountDeployer public immutable accountDeployer;
    address[] public promos;
    mapping(address => address) public accountOf; // a seller's TifoAccount, if they opened one

    struct PromoInfo {
        address promo;
        address seller;
        uint64 closesAt;
        uint64 createdAt;
        uint256 cap;
        string meta;
    }

    PromoInfo[] internal infos;

    /// @param meta JSON: fixture slug, team names, shop name, products. Lets the app list promos from chain alone.
    event PromoCreated(address indexed promo, address indexed seller, bytes32 indexed fixtureId, uint64 closesAt, uint256 cap, string meta);

    event AccountCreated(address indexed owner, address account);

    constructor(address usdc_, address agent_, address operator_) {
        usdc = usdc_;
        agent = agent_;
        operator = operator_;
        accountDeployer = new TifoAccountDeployer();
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
        uint16 floorBps,
        uint16 drawBps,
        uint32 holdSecs,
        uint32 minBuyers,
        string calldata meta
    ) external returns (address promo) {
        require(closesAt > block.timestamp, "kickoff passed");
        promo = address(
            new TifoPromo(usdc, msg.sender, agent, operator, fixtureId, closesAt, settleNotBefore, cap, minBps, maxBps, rateA, rateB, floorBps, drawBps, holdSecs, minBuyers)
        );
        promos.push(promo);
        infos.push(PromoInfo(promo, msg.sender, closesAt, uint64(block.timestamp), cap, meta));
        emit PromoCreated(promo, msg.sender, fixtureId, closesAt, cap, meta);
    }

    /// @notice Open an account with a standing rule for the agent. One per seller wallet.
    /// @param payout where the account's money is sent; the zero address means the seller's own wallet.
    function createAccount(uint16 weeklyBps, uint256 baseWeekly, uint256 perDealCap, address payout) public returns (address account) {
        require(accountOf[msg.sender] == address(0), "exists");
        account = accountDeployer.deploy(usdc, msg.sender, agent, weeklyBps, baseWeekly, perDealCap, payout);
        accountOf[msg.sender] = account;
        emit AccountCreated(msg.sender, account);
    }

    /// @notice A new seller's first step in one transaction: the account with its rule, and the first drop through it.
    function createAccountAndOpen(uint16 weeklyBps, uint256 baseWeekly, uint256 perDealCap, address payout, TifoAccount.Terms calldata t, string calldata meta)
        external
        returns (address account, address promo)
    {
        account = createAccount(weeklyBps, baseWeekly, perDealCap, payout);
        promo = TifoAccount(account).openFirst(t, meta);
    }

    function promosCount() external view returns (uint256) {
        return promos.length;
    }

    /// Every promo with its metadata, readable in one call. No log scanning needed.
    function getPromos(uint256 start, uint256 n) external view returns (PromoInfo[] memory out) {
        uint256 end = start + n > infos.length ? infos.length : start + n;
        out = new PromoInfo[](end > start ? end - start : 0);
        for (uint256 i = start; i < end; i++) out[i - start] = infos[i];
    }
}
