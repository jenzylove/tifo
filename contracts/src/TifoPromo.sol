// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISellerOwner {
    function owner() external view returns (address);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

/// @title TifoPromo
/// @notice One two-sided match promo for one seller. Fans of side A get `rate` back if A wins,
/// fans of side B if B wins; a draw pays every buyer a small thank you (`drawBps`); voided matches pay nothing.
/// The contract keeps exactly enough USDC to cover the largest of the three possible bills and
/// forwards everything else to the seller the moment a sale lands. That bill can never exceed `cap`.
/// The agent can only change offers for future orders, propose a result, and push refunds.
/// It has no path to move funds anywhere except buyers' refunds and the seller's remainder.
/// For physical products (`holdSecs` > 0) the seller's share of each sale is held until the buyer confirms delivery,
/// or `holdSecs` after the seller marks it sent; if the seller never marks it sent, the buyer can take it back.
/// A seller can make the offer depend on reach (`minBuyers`): unless that many different wallets buy before kickoff,
/// nobody is paid back and the seller keeps every sale.
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
        uint16 drawBps; // thank you on a draw, fixed at purchase
        uint64 at;
    }

    /// The agent's decision log and the promo's lifecycle, kept in storage so any app can read the
    /// whole story with a few view calls, without scanning logs.
    struct Entry {
        uint64 at;
        string kind; // rates | note | proposed | corrected | final | refunds | remainder
        string text;
    }

    /// Delivery of one order, for drops that hold payment until the product arrives.
    enum Delivery {
        None, // digital, or the drop does not hold payment
        Held, // paid; waiting for the seller to send
        Sent, // the seller marked it sent; the buyer can confirm or dispute
        Disputed, // the buyer says it did not arrive; the operator decides
        Released, // paid to the seller
        Refunded // returned to the buyer
    }

    struct Shipment {
        Delivery state;
        uint64 sentAt;
        uint256 held; // the seller's share of this order, kept here until delivery
        string tracking; // courier and tracking link or number, as the seller gave it
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_HOLD = 30 days;
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
    uint16 public immutable floorBps; // offer once a side's budget is used up at the current rate
    uint16 public immutable drawBps; // thank you paid to every buyer on a draw
    uint32 public immutable holdSecs; // 0: pay the seller at sale. Otherwise hold until delivery (see Shipment)
    uint32 public immutable minBuyers; // the offer only pays out once this many different wallets bought (0 or 1: from the first sale)

    uint16[2] public rateBps;
    uint256[2] public liability;
    uint256 public drawLiability;
    mapping(bytes32 => bool) public usedRef; // an order reference pays once, so a retried checkout cannot charge twice
    uint256 public salesTotal;
    uint256 public reserve;
    uint32 public buyers; // different wallets that bought

    Order[] public orders;
    Entry[] internal journal;
    uint256 public refundedTotal;
    mapping(address => uint8) public sideOf; // 0 = none, 1 = A, 2 = B
    Shipment[] internal shipments; // one per order, same index
    uint256 public escrowed; // held for deliveries, separate from the refund reserve

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
    event DeliverySent(uint256 indexed order, string tracking);
    event DeliveryDisputed(uint256 indexed order);
    event DeliveryReleased(uint256 indexed order, address to, uint256 amount, bool toBuyer);

    error NotAgent();
    error NotOperator();
    error Closed();
    error BadSide();
    error OneSidePerWallet();
    error OverCap();
    error OfferGone();
    error DuplicateOrder();
    error RateOutOfBounds();
    error TooEarly();
    error AlreadyFinal();
    error NotFinal();
    error BadOutcome();
    error RefundsPending();
    error TransferFailed();
    error NotSeller();
    error NotBuyer();
    error BadState();

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
        uint16 rateB_,
        uint16 floorBps_,
        uint16 drawBps_,
        uint32 holdSecs_,
        uint32 minBuyers_
    ) {
        require(holdSecs_ <= MAX_HOLD, "hold");
        require(minBps_ <= maxBps_ && maxBps_ <= BPS, "bounds");
        require(floorBps_ <= minBps_ && drawBps_ <= BPS, "floor");
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
        floorBps = floorBps_;
        drawBps = drawBps_;
        holdSecs = holdSecs_;
        minBuyers = minBuyers_;
    }

    /// @notice True once enough different wallets bought for the offer to pay out.
    function offerOn() public view returns (bool) {
        return buyers >= minBuyers;
    }

    // ---------------------------------------------------------------- buying

    /// @param minRateBps The lowest offer the buyer accepts. If the shown offer is gone by the time this lands, it reverts.
    function buy(uint8 side, uint256 amount, bytes32 orderRef, uint16 minRateBps) external {
        _buy(msg.sender, msg.sender, side, amount, orderRef, minRateBps);
    }

    /// @notice Pay on behalf of `buyer` (a checkout relayer or a smart-account batch). The rebate goes to `buyer`.
    function buyFor(address buyer, uint8 side, uint256 amount, bytes32 orderRef, uint16 minRateBps) external {
        _buy(msg.sender, buyer, side, amount, orderRef, minRateBps);
    }

    /// @notice Gasless checkout: the buyer signs a USDC permit, anyone (our relayer) submits it.
    /// Funds can only come from the buyer who signed, and the rebate can only go back to them.
    function buyWithPermit(
        address buyer,
        uint8 side,
        uint256 amount,
        bytes32 orderRef,
        uint16 minRateBps,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // A front-run permit leaves the allowance in place, so a failed permit is not fatal.
        try usdc.permit(buyer, address(this), amount, deadline, v, r, s) {} catch {}
        _buy(buyer, buyer, side, amount, orderRef, minRateBps);
    }

    function _buy(address payer, address buyer, uint8 side, uint256 amount, bytes32 orderRef, uint16 minRateBps) internal {
        if (block.timestamp >= closesAt || finalOutcome != Outcome.None || proposed != Outcome.None) revert Closed();
        if (side > 1) revert BadSide();
        require(amount > 0 && buyer != address(0), "amount");
        uint8 s = sideOf[buyer];
        if (s != 0 && s != side + 1) revert OneSidePerWallet();
        if (orderRef != bytes32(0)) {
            if (usedRef[orderRef]) revert DuplicateOrder();
            usedRef[orderRef] = true;
        }

        // The offer steps down when this side's budget is used up: the current rate, then the floor, then no rebate.
        // A sale is never refused for budget, and the bill never passes the cap.
        uint256[2] memory l = liability;
        uint256 room = cap > l[side] ? cap - l[side] : 0;
        uint16 rate = rateBps[side];
        if ((amount * rate) / BPS > room) rate = floorBps;
        if ((amount * rate) / BPS > room) rate = 0;
        if (rate < minRateBps) revert OfferGone();
        uint256 dl = drawLiability;
        uint16 dRate = drawBps;
        if (dl + (amount * dRate) / BPS > cap) dRate = 0;

        l[side] += (amount * rate) / BPS;
        dl += (amount * dRate) / BPS;
        uint256 newReserve = l[0] > l[1] ? l[0] : l[1];
        if (dl > newReserve) newReserve = dl;
        uint256 held = newReserve - reserve;
        uint256 toSeller = amount - held;

        liability = l;
        drawLiability = dl;
        reserve = newReserve;
        salesTotal += amount;
        if (s == 0) buyers++;
        sideOf[buyer] = side + 1;
        orders.push(Order(buyer, side, amount, rate, dRate, uint64(block.timestamp)));

        _pull(payer, amount);
        if (holdSecs > 0) {
            // Physical product: the seller's share waits here until the buyer has it.
            escrowed += toSeller;
            shipments.push(Shipment(Delivery.Held, 0, toSeller, ""));
        } else {
            shipments.push(Shipment(Delivery.None, 0, 0, ""));
            if (toSeller > 0) _send(seller, toSeller);
        }
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

    /// @notice Push refunds to the winning side, or the thank you to everyone on a draw. Anyone can call; the agent calls it the moment the result is final.
    function payRefunds(uint256 maxCount) external returns (uint256 paid) {
        Outcome o = finalOutcome;
        if (o == Outcome.None) revert NotFinal();
        uint256 n = orders.length;
        if (!offerOn()) {
            // Too few buyers for the offer to switch on: nobody is paid back, the seller keeps every sale.
            refundCursor = n;
            return 0;
        }
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
        } else if (o == Outcome.Draw) {
            for (; i < end; i++) {
                Order storage ord = orders[i];
                uint256 amt = (ord.amount * ord.drawBps) / BPS;
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
        if (refundCursor < orders.length && finalOutcome != Outcome.Void && offerOn()) revert RefundsPending();
        require(!remainderReleased, "released");
        remainderReleased = true;
        uint256 amt = reserve;
        reserve = 0;
        if (amt > 0) _send(seller, amt);
        journal.push(Entry(uint64(block.timestamp), "remainder", ""));
        emit RemainderReleased(amt);
    }

    // ---------------------------------------------------------------- delivery

    /// @notice The seller (or the owner of the seller's Tifo account) marks an order sent, with the courier and tracking.
    function markSent(uint256 i, string calldata tracking) external {
        if (!_isSeller(msg.sender)) revert NotSeller();
        Shipment storage sh = shipments[i];
        if (sh.state != Delivery.Held) revert BadState();
        sh.state = Delivery.Sent;
        sh.sentAt = uint64(block.timestamp);
        sh.tracking = tracking;
        emit DeliverySent(i, tracking);
    }

    /// @notice The buyer has the product: the seller is paid now.
    function confirmReceived(uint256 i) external {
        if (msg.sender != orders[i].buyer) revert NotBuyer();
        Delivery st = shipments[i].state;
        if (st != Delivery.Held && st != Delivery.Sent && st != Delivery.Disputed) revert BadState();
        _settleShipment(i, false);
    }

    /// @notice The buyer says it never arrived, within the window after it was marked sent. The operator then decides.
    function dispute(uint256 i) external {
        if (msg.sender != orders[i].buyer) revert NotBuyer();
        Shipment storage sh = shipments[i];
        if (sh.state != Delivery.Sent || block.timestamp >= uint256(sh.sentAt) + holdSecs) revert BadState();
        sh.state = Delivery.Disputed;
        emit DeliveryDisputed(i);
    }

    /// @notice Anyone: pays the seller once the window after "sent" has passed with no dispute.
    function release(uint256 i) external {
        Shipment storage sh = shipments[i];
        if (sh.state != Delivery.Sent || block.timestamp < uint256(sh.sentAt) + holdSecs) revert TooEarly();
        _settleShipment(i, false);
    }

    /// @notice Anyone: returns the money to the buyer if the seller never marked the order sent in time.
    function refundUnsent(uint256 i) external {
        if (shipments[i].state != Delivery.Held || block.timestamp < uint256(orders[i].at) + holdSecs) revert TooEarly();
        _settleShipment(i, true);
    }

    /// @notice The operator settles a disputed delivery, the same single point of trust as a result correction.
    function resolveDispute(uint256 i, bool toBuyer) external {
        if (msg.sender != operator) revert NotOperator();
        if (shipments[i].state != Delivery.Disputed) revert BadState();
        _settleShipment(i, toBuyer);
    }

    function _settleShipment(uint256 i, bool toBuyer) internal {
        Shipment storage sh = shipments[i];
        uint256 amt = sh.held;
        sh.state = toBuyer ? Delivery.Refunded : Delivery.Released;
        sh.held = 0;
        escrowed -= amt;
        address to = toBuyer ? orders[i].buyer : seller;
        if (amt > 0) _send(to, amt);
        emit DeliveryReleased(i, to, amt, toBuyer);
    }

    function _isSeller(address who) internal view returns (bool) {
        if (who == seller) return true;
        if (seller.code.length == 0) return false;
        try ISellerOwner(seller).owner() returns (address o) {
            return o == who;
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------- views

    function getShipments(uint256 start, uint256 n) external view returns (Shipment[] memory out) {
        uint256 end = start + n > shipments.length ? shipments.length : start + n;
        out = new Shipment[](end > start ? end - start : 0);
        for (uint256 i = start; i < end; i++) out[i - start] = shipments[i];
    }

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
