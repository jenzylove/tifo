// Tifo core: pure promo math. No network, no clocks.
// Amounts are USDC base units (6 decimals) as bigint. Rates are basis points (1 bps = 0.01%).
// The promo contract mirrors applyOrder and settle exactly; these functions are the reference.

export type Side = 0 | 1;
export type Outcome = "A" | "B" | "DRAW" | "VOID";

export const BPS = 10_000n;

export interface Odds {
  pA: number;
  pB: number;
  pDraw: number;
}

export interface Order {
  buyer: string;
  side: Side;
  amount: bigint;
  rateBps: bigint; // fixed at purchase time
  drawBps: bigint; // thank you on a draw, fixed at purchase time
}

export interface Book {
  cap: bigint; // the most the seller will ever owe on any result
  floorBps: bigint; // offer once a side's budget is used up at the current rate
  drawBps: bigint; // thank you paid to every buyer on a draw
  liability: [bigint, bigint]; // refund bill if side A wins / if side B wins
  drawLiability: bigint; // bill if the match is drawn
  reserve: bigint; // USDC held by the contract
  orders: Order[];
  sideOf: Record<string, Side>; // one side per wallet
}

export function emptyBook(cap: bigint, floorBps = 0n, drawBps = 0n): Book {
  return { cap, floorBps, drawBps, liability: [0n, 0n], drawLiability: 0n, reserve: 0n, orders: [], sideOf: {} };
}

/**
 * Turn raw market prices into probabilities. Refuses thin or broken markets
 * instead of guessing: a promo priced off bad odds is worse than no promo.
 */
export function normalizeOdds(
  prices: { a: number; draw: number; b: number },
  liquidityUsd: number,
  minLiquidityUsd = 2_000,
): Odds {
  const { a, draw, b } = prices;
  for (const p of [a, draw, b]) {
    if (!Number.isFinite(p) || p <= 0 || p >= 1) throw new Error(`price out of range: ${p}`);
  }
  const sum = a + draw + b;
  if (sum < 0.9 || sum > 1.15) throw new Error(`prices do not add up (sum ${sum.toFixed(3)})`);
  if (liquidityUsd < minLiquidityUsd) throw new Error(`market too thin ($${Math.round(liquidityUsd)})`);
  return { pA: a / sum, pB: b / sum, pDraw: draw / sum };
}

/**
 * Starting offers: every fan gets the same expected discount (`effectiveBps`),
 * so the underdog's fans are offered a bigger rebate. rate = effective / p, clamped.
 */
export function initialRates(
  odds: Odds,
  effectiveBps: number,
  minBps: number,
  maxBps: number,
): [bigint, bigint] {
  // Offers are shown to fans, so keep them whole percentages.
  const r = (p: number) => BigInt(roundPct(clamp(effectiveBps / p, minBps, maxBps), minBps, maxBps));
  return [r(odds.pA), r(odds.pB)];
}

export function requiredReserve(liability: [bigint, bigint], drawLiability = 0n): bigint {
  const top = liability[0] > liability[1] ? liability[0] : liability[1];
  return drawLiability > top ? drawLiability : top;
}

export interface OrderResult {
  book: Book;
  hold: bigint; // kept in reserve from this sale
  toSeller: bigint; // forwarded to the seller immediately
  refundIfWins: bigint;
  rateBps: bigint; // the offer this order actually got
}

/**
 * What a buyer on `side` gets right now. The offer steps down when that side's budget is used up:
 * the current rate, then the floor, then no rebate. A sale is never refused for budget.
 */
export function offerFor(book: Book, side: Side, amount: bigint, rateBps: bigint): bigint {
  const room = book.cap > book.liability[side] ? book.cap - book.liability[side] : 0n;
  let rate = rateBps;
  if ((amount * rate) / BPS > room) rate = book.floorBps;
  if ((amount * rate) / BPS > room) rate = 0n;
  return rate;
}

/**
 * Apply one sale. The reserve only grows by the increase in the largest bill,
 * so sales on the lighter side usually go to the seller in full.
 * `minRateBps` is the lowest offer the buyer accepts: if the shown offer is gone, the sale is refused.
 */
export function applyOrder(book: Book, buyer: string, side: Side, amount: bigint, rateBps: bigint, minRateBps = 0n): OrderResult {
  if (amount <= 0n) throw new Error("amount must be positive");
  if (rateBps < 0n || rateBps > BPS) throw new Error("rate out of range");
  const key = buyer.toLowerCase();
  const existing = book.sideOf[key];
  if (existing !== undefined && existing !== side) throw new Error("one side per wallet");

  const rate = offerFor(book, side, amount, rateBps);
  if (rate < minRateBps) throw new Error("offer gone: this side's budget is used up at that rate");
  const drawRate = book.drawLiability + (amount * book.drawBps) / BPS > book.cap ? 0n : book.drawBps;

  const refundIfWins = (amount * rate) / BPS;
  const liability: [bigint, bigint] = [...book.liability] as [bigint, bigint];
  liability[side] += refundIfWins;
  const drawLiability = book.drawLiability + (amount * drawRate) / BPS;
  const newReserve = requiredReserve(liability, drawLiability);

  const hold = newReserve - book.reserve;
  return {
    book: {
      ...book,
      liability,
      drawLiability,
      reserve: newReserve,
      orders: [...book.orders, { buyer: key, side, amount, rateBps: rate, drawBps: drawRate }],
      sideOf: { ...book.sideOf, [key]: side },
    },
    hold,
    toSeller: amount - hold,
    refundIfWins,
    rateBps: rate,
  };
}

/**
 * Live rebalancing. When one side's refund bill runs ahead, raise the lighter side's
 * offer and lower the heavier side's, in proportion to the gap. Never leaves [min, max].
 * With `budget`, the gap is measured against the drop's budget, so the offers only move as one side
 * actually eats into it (one early sale barely moves anything); without it, against the bigger bill.
 */
export function rebalance(
  liability: [bigint, bigint],
  base: [bigint, bigint],
  minBps: number,
  maxBps: number,
  strength = 0.5,
  budget?: bigint,
): [bigint, bigint] {
  const [la, lb] = liability.map(Number);
  const top = Math.max(la, lb, Number(budget ?? 0n));
  if (top === 0) return base;
  const gap = (la - lb) / top; // +ve: A heavy, -ve: B heavy
  const heavy: Side = gap > 0 ? 0 : 1;
  const light: Side = heavy === 0 ? 1 : 0;
  const g = Math.abs(gap) * strength;
  const out: [number, number] = [Number(base[0]), Number(base[1])];
  out[light] = out[light] * (1 + g);
  out[heavy] = out[heavy] * (1 - g);
  return [BigInt(roundPct(clamp(out[0], minBps, maxBps), minBps, maxBps)), BigInt(roundPct(clamp(out[1], minBps, maxBps), minBps, maxBps))];
}

export interface Settlement {
  refunds: { buyer: string; amount: bigint }[];
  totalRefunds: bigint;
  toSeller: bigint; // reserve left over
}

/** Pay the winning side, or the thank you to every buyer on a draw. A voided match pays nothing. */
export function settle(book: Book, outcome: Outcome): Settlement {
  const winner: Side | null = outcome === "A" ? 0 : outcome === "B" ? 1 : null;
  const refunds = (
    winner !== null
      ? book.orders.filter((o) => o.side === winner).map((o) => ({ buyer: o.buyer, amount: (o.amount * o.rateBps) / BPS }))
      : outcome === "DRAW"
        ? book.orders.map((o) => ({ buyer: o.buyer, amount: (o.amount * o.drawBps) / BPS }))
        : []
  ).filter((r) => r.amount > 0n);
  const totalRefunds = refunds.reduce((s, r) => s + r.amount, 0n);
  if (totalRefunds > book.reserve) throw new Error("reserve short: invariant broken");
  return { refunds, totalRefunds, toSeller: book.reserve - totalRefunds };
}

/** What the promo costs the seller on average, given the odds. */
export function expectedCost(liability: [bigint, bigint], odds: Odds, drawLiability = 0n): number {
  return Number(liability[0]) * odds.pA + Number(liability[1]) * odds.pB + Number(drawLiability) * odds.pDraw;
}

/** Round to a whole percent (100 bps), staying inside the bounds. */
function roundPct(x: number, lo: number, hi: number) {
  const r = Math.round(x / 100) * 100;
  return Math.min(hi, Math.max(lo, r));
}

function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}
