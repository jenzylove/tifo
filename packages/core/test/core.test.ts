import { describe, expect, it } from "vitest";
import {
  applyOrder,
  emptyBook,
  expectedCost,
  initialRates,
  normalizeOdds,
  rebalance,
  requiredReserve,
  settle,
  type Book,
  type Side,
} from "../src/index";

const usd = (n: number) => BigInt(Math.round(n * 1e6));

describe("normalizeOdds", () => {
  it("normalizes a real three-way market", () => {
    // Arsenal v Lille, Polymarket 1 Oct 2026
    const o = normalizeOdds({ a: 0.78, draw: 0.14, b: 0.085 }, 9294);
    expect(o.pA + o.pB + o.pDraw).toBeCloseTo(1, 9);
    expect(o.pA).toBeGreaterThan(0.77);
  });
  it("refuses thin markets and prices that don't add up", () => {
    expect(() => normalizeOdds({ a: 0.48, draw: 0.505, b: 0.485 }, 380)).toThrow(/add up|thin/);
    expect(() => normalizeOdds({ a: 0.4, draw: 0.3, b: 0.3 }, 500)).toThrow(/thin/);
  });
});

describe("initialRates", () => {
  it("gives the underdog's fans the bigger rebate for the same expected discount", () => {
    const [ra, rb] = initialRates({ pA: 0.6, pB: 0.2, pDraw: 0.2 }, 1000, 500, 5000);
    expect(ra).toBe(1700n); // 10% / 0.6 = 16.67%, shown as a whole 17%
    expect(rb).toBe(5000n); // 10% / 0.2 = 50%, at the cap
  });
});

describe("applyOrder", () => {
  it("holds only the increase in the larger refund bill", () => {
    let b = emptyBook(usd(100));
    let r = applyOrder(b, "0xA1", 0, usd(50), 3000n); // A owes 15 if A wins
    expect(r.hold).toBe(usd(15));
    expect(r.toSeller).toBe(usd(35));
    b = r.book;
    r = applyOrder(b, "0xB1", 1, usd(30), 4000n); // B owes 12 if B wins; max still 15
    expect(r.hold).toBe(0n);
    expect(r.toSeller).toBe(usd(30));
    expect(r.book.reserve).toBe(usd(15));
  });
  it("enforces one side per wallet and the cap", () => {
    let b = applyOrder(emptyBook(usd(10)), "0xA1", 0, usd(20), 4000n).book; // 8 of 10
    expect(() => applyOrder(b, "0xa1", 1, usd(1), 4000n)).toThrow(/one side/);
    expect(() => applyOrder(b, "0xA2", 0, usd(10), 4000n)).toThrow(/over cap/);
  });
});

describe("rebalance", () => {
  it("raises the light side and lowers the heavy side within bounds", () => {
    const [ra, rb] = rebalance([usd(80), usd(20)], [3000n, 3000n], 1000, 6000);
    expect(ra).toBeLessThan(3000n);
    expect(rb).toBeGreaterThan(3000n);
    const [xa, xb] = rebalance([usd(100), 0n], [3000n, 5000n], 2000, 6000, 1);
    expect(xa).toBe(2000n);
    expect(xb).toBe(6000n);
  });
});

describe("settle", () => {
  it("pays the winners from reserve and returns the rest", () => {
    let b = emptyBook(usd(100));
    b = applyOrder(b, "0xA1", 0, usd(50), 3000n).book;
    b = applyOrder(b, "0xB1", 1, usd(30), 4000n).book;
    const sA = settle(b, "A");
    expect(sA.totalRefunds).toBe(usd(15));
    expect(sA.toSeller).toBe(0n);
    const sB = settle(b, "B");
    expect(sB.totalRefunds).toBe(usd(12));
    expect(sB.toSeller).toBe(usd(3));
    expect(settle(b, "DRAW").toSeller).toBe(usd(15));
    expect(settle(b, "VOID").refunds).toHaveLength(0);
  });
});

// Replay: thousands of random, deliberately lopsided order flows.
// Invariants: reserve always covers either result, never exceeds the cap,
// and every dollar a buyer pays is accounted for (seller + reserve).
describe("replay invariants under skewed sales", () => {
  function rng(seed: number) {
    return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }
  it("holds for 2,000 promos", () => {
    const rand = rng(42);
    for (let promo = 0; promo < 2000; promo++) {
      const skew = rand(); // share of buyers on side A
      const odds = { pA: 0.2 + rand() * 0.6, pB: 0, pDraw: 0.2 };
      odds.pB = Math.max(0.05, 1 - odds.pA - odds.pDraw);
      const min = 500, max = 6000;
      const base = initialRates(odds, 800 + Math.floor(rand() * 800), min, max);
      let rates = base;
      let book: Book = emptyBook(usd(50 + rand() * 450));
      let paid = 0n, seller = 0n;
      for (let i = 0; i < 80; i++) {
        const side: Side = rand() < skew ? 0 : 1;
        const amount = usd(5 + Math.floor(rand() * 60));
        try {
          const r = applyOrder(book, `0x${promo}-${i}`, side, amount, rates[side]);
          book = r.book;
          paid += amount;
          seller += r.toSeller;
        } catch (e) {
          expect(String(e)).toMatch(/over cap/); // a full side is refused, never overdrawn
        }
        rates = rebalance(book.liability, base, min, max);
        expect(book.reserve).toBe(requiredReserve(book.liability));
        expect(book.reserve <= book.cap).toBe(true);
      }
      expect(seller + book.reserve).toBe(paid);
      for (const o of ["A", "B", "DRAW", "VOID"] as const) {
        const s = settle(book, o);
        expect(s.totalRefunds + s.toSeller).toBe(book.reserve);
      }
      expect(expectedCost(book.liability, odds)).toBeLessThanOrEqual(Number(book.cap));
    }
  });
});
