// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

/// @title TifoPromo
/// @notice One two-sided match promo for one seller. Fans of side A get `rate` back if A wins,
/// fans of side B if B wins; draws and voided matches pay no rebates.
/// The contract keeps exactly enough USDC to cover the larger of the two refund bills and
/// forwards everything else to the seller the moment a sale lands. That bill can never exceed `cap`.
/// The agent can only change offers for future orders, propose a result, and push refunds.
/// It has no path to move funds anywhere except buyers' refunds and the seller's remainder.
contract TifoPromo {
    enum Outcome {
        None,
        A,
        B,
        Draw,
        Void
    }

    struct Order {
        address buyer;
        uint8 side; // 0 = A, 1 = B
        uint256 amount;
        uint16 rateBps; // fixed at purchase
        uint64 at;
    }

    /// The agent's decision log and the promo's lifecycle, kept in storage so any app can read the
    /// whole story with a few view calls, without scanning logs.
    struct Entry {
        uint64 at;
        string kind; // rates | note | proposed | corrected | final | refunds | remainder
        string text;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant CHALLENGE_WINDOW = 15 minutes;
    uint256 public constant ABANDON_AFTER = 3 days;

    IERC20 public immutable usdc;
    address public immutable seller;
    address public immutable agent;
    address public immutable operator;
    bytes32 public immutable fixtureId;
    uint64 public immutable closesAt; // kickoff: no orders after this
    uint64 public immutable settleNotBefore; // earliest moment a win/draw can be proposed
    uint256 public immutable cap;
    uint16 public immutable minBps;
    uint16 public immutable maxBps;

    uint16[2] public rateBps;
    uint256[2] public liability;
    uint256 public reserve;

    Order[] public orders;
    Entry[] internal journal;
    uint256 public refundedTotal;
    mapping(address => uint8) public sideOf; // 0 = none, 1 = A, 2 = B

    Outcome public proposed;
    uint64 public proposedAt;
    bytes32 public evidence;
    Outcome public finalOutcome;
    uint256 public refundCursor;
    bool public remainderReleased;

    event Sale(address indexed buyer, uint8 side, uint256 amount, uint16 rateBps, uint256 held, uint256 toSeller, bytes32 orderRef);
    event RatesChanged(uint16 rateA, uint16 rateB, string reason);
    event Decision(string kind, string reason);
    event ResultProposed(Outcome outcome, bytes32 evidence);
    event ResultCorrected(Outcome outcome, bytes32 evidence);
    event Finalized(Outcome outcome);
    event Refunded(address indexed buyer, uint256 amount);
    event RemainderReleased(uint256 amount);

    error NotAgent();
    error NotOperator();
    error Closed();
    error BadSide();
    error OneSidePerWallet();
    error OverCap();
    error RateOutOfBounds();
    error TooEarly();
    error AlreadyFinal();
    error NotFinal();
    error BadOutcome();
    error RefundsPending();
    error TransferFailed();

    constructor(
        address usdc_,
        address seller_,
        address agent_,
        address operator_,
        bytes32 fixtureId_,
        uint64 closesAt_,
        uint64 settleNotBefore_,
        uint256 cap_,
        uint16 minBps_,
        uint16 maxBps_,
        uint16 rateA_,
        uint16 rateB_
    ) {
        require(minBps_ <= maxBps_ && maxBps_ <= BPS, "bounds");
        require(settleNotBefore_ >= closesAt_, "times");
        require(rateA_ >= minBps_ && rateA_ <= maxBps_ && rateB_ >= minBps_ && rateB_ <= maxBps_, "rates");
        usdc = IERC20(usdc_);
        seller = seller_;
        agent = agent_;
        operator = operator_;
        fixtureId = fixtureId_;
        closesAt = closesAt_;
        settleNotBefore = settleNotBefore_;
        cap = cap_;
        minBps = minBps_;
        maxBps = maxBps_;
        rateBps = [rateA_, rateB_];
    }

    // ---------------------------------------------------------------- buying

    function buy(uint8 side, uint256 amount, bytes32 orderRef) external {
        _buy(msg.sender, msg.sender, side, amount, orderRef);
    }

    /// @notice Pay on behalf of `buyer` (a checkout relayer or a smart-account batch). The rebate goes to `buyer`.
    function buyFor(address buyer, uint8 side, uint256 amount, bytes32 orderRef) external {
        _buy(msg.sender, buyer, side, amount, orderRef);
    }

    /// @notice Gasless checkout: the buyer signs a USDC permit, anyone (our relayer) submits it.
    /// Funds can only come from the buyer who signed, and the rebate can only go back to them.
    function buyWithPermit(
        address buyer,
        uint8 side,
        uint256 amount,
        bytes32 orderRef,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // A front-run permit leaves the allowance in place, so a failed permit is not fatal.
        try usdc.permit(buyer, address(this), amount, deadline, v, r, s) {} catch {}
        _buy(buyer, buyer, side, amount, orderRef);
    }

    function _buy(address payer, address buyer, uint8 side, uint256 amount, bytes32 orderRef) internal {
        if (block.timestamp >= closesAt || finalOutcome != Outcome.None || proposed != Outcome.None) revert Closed();
        if (side > 1) revert BadSide();
        require(amount > 0 && buyer != address(0), "amount");
        uint8 s = sideOf[buyer];
        if (s != 0 && s != side + 1) revert OneSidePerWallet();

        uint16 rate = rateBps[side];
        uint256 refundIfWins = (amount * rate) / BPS;
        uint256[2] memory l = liability;
        l[side] += refundIfWins;
        uint256 newReserve = l[0] > l[1] ? l[0] : l[1];
        if (newReserve > cap) revert OverCap();
        uint256 held = newReserve - reserve;
        uint256 toSeller = amount - held;

        liability = l;
        reserve = newReserve;
        sideOf[buyer] = side + 1;
        orders.push(Order(buyer, side, amount, rate, uint64(block.timestamp)));

        _pull(payer, amount);
        if (toSeller > 0) _send(seller, toSeller);
        emit Sale(buyer, side, amount, rate, held, toSeller, orderRef);
    }

    // ---------------------------------------------------------------- agent

    function setRates(uint16 rateA, uint16 rateB, string calldata reason) external {
        if (msg.sender != agent) revert NotAgent();
        if (block.timestamp >= closesAt) revert Closed();
        if (rateA < minBps || rateA > maxBps || rateB < minBps || rateB > maxBps) revert RateOutOfBounds();
        rateBps = [rateA, rateB];
        journal.push(Entry(uint64(block.timestamp), "rates", reason));
        emit RatesChanged(rateA, rateB, reason);
    }

    /// @notice The agent's decision log, on chain: why it priced, held, settled or escalated.
    function note(string calldata kind, string calldata reason) external {
        if (msg.sender != agent) revert NotAgent();
        journal.push(Entry(uint64(block.timestamp), kind, reason));
        emit Decision(kind, reason);
    }

    /// @notice The agent proposes the result once two independent sources agree. `evidence` hashes their payloads.
    function proposeResult(Outcome o, bytes32 evidence_) external {
        if (msg.sender != agent) revert NotAgent();
        if (finalOutcome != Outcome.None) revert AlreadyFinal();
        if (o == Outcome.None) revert BadOutcome();
        if (o == Outcome.Void) {
            if (block.timestamp < closesAt) revert TooEarly();
        } else if (block.timestamp < settleNotBefore) {
            revert TooEarly();
        }
        proposed = o;
        proposedAt = uint64(block.timestamp);
        evidence = evidence_;
        journal.push(Entry(uint64(block.timestamp), "proposed", _name(o)));
        emit ResultProposed(o, evidence_);
    }

    /// @notice The operator (not the seller, who pays the refunds) can correct a wrong proposal within the window.
    function correctResult(Outcome o, bytes32 evidence_) external {
        if (msg.sender != operator) revert NotOperator();
        if (finalOutcome != Outcome.None) revert AlreadyFinal();
        if (o == Outcome.None) revert BadOutcome();
        if (block.timestamp < closesAt) revert TooEarly();
        if (o != Outcome.Void && block.timestamp < settleNotBefore) revert TooEarly();
        proposed = o;
        evidence = evidence_;
        journal.push(Entry(uint64(block.timestamp), "corrected", _name(o)));
        _finalize(o);
        emit ResultCorrected(o, evidence_);
    }

    /// @notice Anyone can finalize once the challenge window has passed, or void a promo nobody settled.
    function finalize() external {
        if (finalOutcome != Outcome.None) revert AlreadyFinal();
        if (proposed != Outcome.None) {
            if (block.timestamp < proposedAt + CHALLENGE_WINDOW) revert TooEarly();
            _finalize(proposed);
        } else {
            if (block.timestamp < uint256(closesAt) + ABANDON_AFTER) revert TooEarly();
            _finalize(Outcome.Void);
        }
    }

    function _finalize(Outcome o) internal {
        finalOutcome = o;
        journal.push(Entry(uint64(block.timestamp), "final", _name(o)));
        emit Finalized(o);
    }

    // ---------------------------------------------------------------- settlement

    /// @notice Push refunds to the winning side. Anyone can call; the agent calls it the moment the result is final.
    function payRefunds(uint256 maxCount) external returns (uint256 paid) {
        Outcome o = finalOutcome;
        if (o == Outcome.None) revert NotFinal();
        uint256 n = orders.length;
        uint256 i = refundCursor;
        uint256 end = i + maxCount > n ? n : i + maxCount;
        if (o == Outcome.A || o == Outcome.B) {
            uint8 winner = o == Outcome.A ? 0 : 1;
            for (; i < end; i++) {
                Order storage ord = orders[i];
                if (ord.side != winner) continue;
                uint256 amt = (ord.amount * ord.rateBps) / BPS;
                if (amt == 0) continue;
                reserve -= amt;
                refundedTotal += amt;
                _send(ord.buyer, amt);
                emit Refunded(ord.buyer, amt);
                paid++;
            }
        } else {
            i = end;
        }
        refundCursor = end;
    }

    function releaseRemainder() external {
        if (finalOutcome == Outcome.None) revert NotFinal();
        if (refundCursor < orders.length && (finalOutcome == Outcome.A || finalOutcome == Outcome.B)) revert RefundsPending();
        require(!remainderReleased, "released");
        remainderReleased = true;
        uint256 amt = reserve;
        reserve = 0;
        if (amt > 0) _send(seller, amt);
        journal.push(Entry(uint64(block.timestamp), "remainder", ""));
        emit RemainderReleased(amt);
    }

    // ---------------------------------------------------------------- views

    function ordersCount() external view returns (uint256) {
        return orders.length;
    }

    function journalCount() external view returns (uint256) {
        return journal.length;
    }

    function getOrders(uint256 start, uint256 n) external view returns (Order[] memory out) {
        uint256 end = start + n > orders.length ? orders.length : start + n;
        out = new Order[](end > start ? end - start : 0);
        for (uint256 i = start; i < end; i++) out[i - start] = orders[i];
    }

    function getJournal(uint256 start, uint256 n) external view returns (Entry[] memory out) {
        uint256 end = start + n > journal.length ? journal.length : start + n;
        out = new Entry[](end > start ? end - start : 0);
        for (uint256 i = start; i < end; i++) out[i - start] = journal[i];
    }

    function _name(Outcome o) internal pure returns (string memory) {
        if (o == Outcome.A) return "A";
        if (o == Outcome.B) return "B";
        if (o == Outcome.Draw) return "Draw";
        if (o == Outcome.Void) return "Void";
        return "None";
    }

    function book()
        external
        view
        returns (uint16 rateA, uint16 rateB, uint256 liabilityA, uint256 liabilityB, uint256 reserve_, uint256 cap_, uint256 count)
    {
        return (rateBps[0], rateBps[1], liability[0], liability[1], reserve, cap, orders.length);
    }

    // ---------------------------------------------------------------- internals

    function _pull(address from, uint256 amount) internal {
        if (!usdc.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _send(address to, uint256 amount) internal {
        if (!usdc.transfer(to, amount)) revert TransferFailed();
    }
}
