// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Lite {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface ITifoFactory {
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
        uint256 minAmount,
        string calldata meta
    ) external returns (address);
}

interface ITifoPromoSales {
    function salesTotal() external view returns (uint256);
}

/// @title TifoAccount
/// @notice A seller's account with a standing instruction for their sales manager.
/// Sales from the seller's drops land here. The owner sets one rule: how much the agent may put
/// at risk on drops each week (a fixed base plus a share of the last 7 days of sales) and the most
/// for a single drop. Inside the rule the agent opens drops by itself. Outside it, the agent can only
/// write a proposal that the owner approves. The agent cannot take money out for itself: the only place it can send
/// the account's balance is the payout wallet the owner chose.
contract TifoAccount {
    struct Terms {
        bytes32 fixtureId;
        uint64 closesAt;
        uint64 settleNotBefore;
        uint256 cap;
        uint16 minBps;
        uint16 maxBps;
        uint16 rateA;
        uint16 rateB;
        uint16 floorBps;
        uint16 drawBps;
        uint32 holdSecs; // 0 for digital; otherwise payment waits for delivery
        uint32 minBuyers; // the offer only pays out once this many different wallets bought; 0 for always
        uint256 minAmount; // the least one order may pay: the price of one unit
    }

    struct Deal {
        address promo;
        uint64 createdAt;
        uint64 closesAt;
        uint256 cap;
        bool byAgent; // opened by the agent alone, inside the rule
        string reason; // the agent's own words, or the approved proposal's
    }

    /// One transfer of the account's balance to the owner's payout wallet.
    struct Payout {
        uint64 at;
        address to;
        uint256 amount;
        string reason;
    }

    struct Proposal {
        Terms terms;
        string meta;
        string reason;
        uint64 at;
        uint8 status; // 0 waiting, 1 approved, 2 declined
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant WEEK = 7 days;

    IERC20Lite public immutable usdc;
    address public immutable owner;
    address public immutable agent;
    ITifoFactory public immutable factory;

    uint16 public weeklyBps; // share of the last 7 days of sales the agent may put at risk each week
    uint256 public baseWeekly; // a fixed weekly amount on top, so a new seller is not stuck at zero
    uint256 public perDealCap; // the most one drop may cost
    address public payout; // where the seller's money goes; only the owner can change it
    uint256 public paidOutTotal;

    Deal[] internal deals;
    Proposal[] internal proposals;
    Payout[] internal payouts;

    event LimitsSet(uint16 weeklyBps, uint256 baseWeekly, uint256 perDealCap);
    event DealOpened(address indexed promo, uint256 cap, bool byAgent, string reason);
    event Proposed(uint256 indexed id, uint256 cap, string reason);
    event Decided(uint256 indexed id, bool approved);
    event Withdrawn(address indexed to, uint256 amount);
    event PayoutSet(address to);
    event PaidOut(address indexed to, uint256 amount, string reason);

    error NotOwner();
    error NotAgent();
    error OverLimit();
    error AlreadyDecided();
    error TransferFailed();
    error NotFactory();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    constructor(address usdc_, address owner_, address agent_, address factory_, uint16 weeklyBps_, uint256 baseWeekly_, uint256 perDealCap_, address payout_) {
        require(weeklyBps_ <= BPS, "share");
        usdc = IERC20Lite(usdc_);
        owner = owner_;
        agent = agent_;
        factory = ITifoFactory(factory_);
        weeklyBps = weeklyBps_;
        baseWeekly = baseWeekly_;
        perDealCap = perDealCap_;
        payout = payout_ == address(0) ? owner_ : payout_;
    }

    // ---------------------------------------------------------------- owner

    /// @notice Where the account's money is sent. Only the owner can set it, so the agent can only ever pay the owner.
    function setPayout(address to) external onlyOwner {
        require(to != address(0), "payout");
        payout = to;
        emit PayoutSet(to);
    }

    /// @notice The first drop, opened in the same step that creates the account. Only the factory calls this, and only
    /// for the wallet that asked it to create this account.
    function openFirst(Terms calldata t, string calldata meta) external returns (address) {
        if (msg.sender != address(factory) || deals.length != 0) revert NotFactory();
        return _open(t, meta, false, "");
    }

    function setLimits(uint16 weeklyBps_, uint256 baseWeekly_, uint256 perDealCap_) external onlyOwner {
        require(weeklyBps_ <= BPS, "share");
        weeklyBps = weeklyBps_;
        baseWeekly = baseWeekly_;
        perDealCap = perDealCap_;
        emit LimitsSet(weeklyBps_, baseWeekly_, perDealCap_);
    }

    /// @notice The owner opens a drop directly. It still counts toward this week's total.
    function open(Terms calldata t, string calldata meta) external onlyOwner returns (address) {
        return _open(t, meta, false, "");
    }

    function decide(uint256 id, bool approve) external onlyOwner returns (address promo) {
        Proposal storage p = proposals[id];
        if (p.status != 0) revert AlreadyDecided();
        p.status = approve ? 1 : 2;
        emit Decided(id, approve);
        if (approve) promo = _open(p.terms, p.meta, false, p.reason);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        if (!usdc.transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    // ---------------------------------------------------------------- agent

    /// @notice The agent opens a drop by itself. Reverts if it would break the owner's rule.
    function openDeal(Terms calldata t, string calldata meta, string calldata reason) external onlyAgent returns (address) {
        if (t.cap > perDealCap || committed() + t.cap > allowance()) revert OverLimit();
        return _open(t, meta, true, reason);
    }

    /// @notice Send everything the account holds to the owner's payout wallet. The agent (or the owner) decides when;
    /// neither chooses where. Refunds are never at risk: each drop keeps its own refund money until full time.
    function payOut(string calldata reason) external returns (uint256 amount) {
        if (msg.sender != agent && msg.sender != owner) revert NotAgent();
        amount = usdc.balanceOf(address(this));
        if (amount == 0) return 0;
        paidOutTotal += amount;
        payouts.push(Payout(uint64(block.timestamp), payout, amount, reason));
        if (!usdc.transfer(payout, amount)) revert TransferFailed();
        emit PaidOut(payout, amount, reason);
    }

    /// @notice Anything outside the rule is only a proposal until the owner approves it.
    function propose(Terms calldata t, string calldata meta, string calldata reason) external onlyAgent returns (uint256 id) {
        id = proposals.length;
        proposals.push(Proposal(t, meta, reason, uint64(block.timestamp), 0));
        emit Proposed(id, t.cap, reason);
    }

    // ---------------------------------------------------------------- views

    /// @notice Sales of this account's drops that kicked off in the last 7 days.
    function recentSales() public view returns (uint256 total) {
        for (uint256 i = deals.length; i > 0; i--) {
            Deal storage d = deals[i - 1];
            if (d.createdAt + 4 * WEEK < block.timestamp) break; // older drops cannot have kicked off this week
            if (d.closesAt <= block.timestamp && d.closesAt + WEEK > block.timestamp) total += ITifoPromoSales(d.promo).salesTotal();
        }
    }

    /// @notice What the agent may put at risk across drops opened in any 7 days.
    function allowance() public view returns (uint256) {
        return baseWeekly + (recentSales() * weeklyBps) / BPS;
    }

    /// @notice Budgets of drops opened in the last 7 days.
    function committed() public view returns (uint256 total) {
        for (uint256 i = deals.length; i > 0; i--) {
            Deal storage d = deals[i - 1];
            if (d.createdAt + WEEK <= block.timestamp) break;
            total += d.cap;
        }
    }

    function dealsCount() external view returns (uint256) {
        return deals.length;
    }

    function proposalsCount() external view returns (uint256) {
        return proposals.length;
    }

    function payoutsCount() external view returns (uint256) {
        return payouts.length;
    }

    function getPayouts(uint256 start, uint256 n) external view returns (Payout[] memory out) {
        uint256 end = start + n > payouts.length ? payouts.length : start + n;
        out = new Payout[](end > start ? end - start : 0);
        for (uint256 i = start; i < end; i++) out[i - start] = payouts[i];
    }

    function getDeals(uint256 start, uint256 n) external view returns (Deal[] memory out) {
        uint256 end = start + n > deals.length ? deals.length : start + n;
        out = new Deal[](end > start ? end - start : 0);
        for (uint256 i = start; i < end; i++) out[i - start] = deals[i];
    }

    function getProposals(uint256 start, uint256 n) external view returns (Proposal[] memory out) {
        uint256 end = start + n > proposals.length ? proposals.length : start + n;
        out = new Proposal[](end > start ? end - start : 0);
        for (uint256 i = start; i < end; i++) out[i - start] = proposals[i];
    }

    // ---------------------------------------------------------------- internals

    function _open(Terms memory t, string memory meta, bool byAgent, string memory reason) internal returns (address promo) {
        promo = factory.createPromo(t.fixtureId, t.closesAt, t.settleNotBefore, t.cap, t.minBps, t.maxBps, t.rateA, t.rateB, t.floorBps, t.drawBps, t.holdSecs, t.minBuyers, t.minAmount, meta);
        deals.push(Deal(promo, uint64(block.timestamp), t.closesAt, t.cap, byAgent, reason));
        emit DealOpened(promo, t.cap, byAgent, reason);
    }
}
