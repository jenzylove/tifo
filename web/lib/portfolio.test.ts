import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { DropRow } from "./manager";
import type { Match } from "./matches";
import { planFrom, type ModelDecision } from "./planner";
import { capThreshold, chooseTier, emptyStreak, knownProfit, steadyBudget, stopLoss } from "./portfolio";
import type { AccountState } from "./tifoAccount";

const usdc = (n: number) => String(Math.round(n * 1e6));
const meta = (over: Partial<DropRow["meta"]> = {}): DropRow["meta"] => ({
  slug: "old", league: "Premier League", teamA: "Arsenal FC", teamB: "Chelsea FC", kickoff: "2026-10-01T15:00:00Z",
  shop: "Glow", product: "Shea butter", priceUsd: 10, backBps: 5_000, shape: "back", stock: 10,
  baseRates: [5_000, 5_000], minBps: 5_000, maxBps: 5_000, effectiveBps: 5_000, ...over,
});
const drop = (orders: number, over: Partial<DropRow> = {}, m: Partial<DropRow["meta"]> = {}): DropRow => ({
  address: "0x0000000000000000000000000000000000000001", meta: meta(m), closesAt: 0, phase: "settled", outcome: "A", rates: [5_000, 5_000],
  orders, fans: orders, sales: usdc(orders * 10), held: "0", refunded: "0", cap: usdc(20), bySide: [orders, 0], byAgent: true, reconciled: true,
  extraSalesToBreakEven: null, ...over,
});
const account = (allowance = 30, committed = 0, perDrop = 25): AccountState => ({
  address: "0x00000000000000000000000000000000000000aa" as Address, weeklyBps: 1000, baseWeekly: usdc(allowance), perDealCap: usdc(perDrop),
  allowance: usdc(allowance), committed: usdc(committed), recentSales: "0", balance: "0", payout: "0x00000000000000000000000000000000000000bb" as Address,
  paidOut: "0", deals: [], payouts: [], proposals: [], current: true,
});
const match: Match = {
  slug: "epl-ars-che-2026-11-07", league: { prefix: "epl", name: "Premier League", espn: "eng.1", durationMin: 110 }, title: "Arsenal vs Chelsea",
  teamA: "Arsenal FC", teamB: "Chelsea FC", kickoff: "2026-11-07T17:30:00Z", prices: { a: 0.5, draw: 0.25, b: 0.25 }, liquidityUsd: 1e5,
  odds: { pA: 0.5, pDraw: 0.25, pB: 0.25 } as Match["odds"],
};
const model = (back_pct: number) => async (): Promise<ModelDecision> => ({ act: "run", match_slug: match.slug, back_pct, reason: "Arsenal v Chelsea is the big one this week." });

describe("stop loss", () => {
  it("counts settled empty drops in a row and ignores a running one", () => {
    expect(emptyStreak([drop(0, { phase: "open" }), drop(0), drop(0), drop(3)])).toBe(2);
    expect(emptyStreak([drop(0), drop(2), drop(0)])).toBe(1);
  });
  it("stops after two empty drops and proposes changes, never a bigger offer", () => {
    const s = stopLoss([drop(0), drop(0)], 0);
    expect(s.halted).toBe(true);
    expect(s.advice.map((a) => a.kind)).toEqual(["customers", "stock", "product"]);
    expect(s.advice.find((a) => a.kind === "stock")!.text).toContain("5 instead of 10");
    expect(stopLoss([drop(0), drop(0)], 12).advice[0].text).toContain("12 saved customers");
    expect(stopLoss([drop(0), drop(4)], 0).halted).toBe(false);
  });
  it("the planner does not ask the model or open anything while stopped", async () => {
    let asked = false;
    const p = await planFrom({ name: "Glow", account: account(), drops: [drop(0), drop(0)], fixtures: [match] }, async () => {
      asked = true;
      return { act: "run", reason: "" };
    });
    expect(asked).toBe(false);
    expect(p.act).toBe("skip");
    expect(p.halted).toBe(true);
    expect(p.terms).toBeUndefined();
  });
  it("after one empty drop the planner keeps the offer, even when the model asks for free", async () => {
    const p = await planFrom({ name: "Glow", account: account(), drops: [drop(0, {}, { profitUsd: 4 })], fixtures: [match] }, model(100));
    expect(p.terms!.rateA).toBe(5_000);
    expect(p.reason).toContain("kept the offer at 50% back");
  });
});

describe("steady budget", () => {
  it("is a third of the week's allowance, inside what is left and the per drop limit", () => {
    expect(steadyBudget({ allowanceUsd: 30, leftUsd: 30, perDropUsd: 25 })).toBe(10);
    expect(steadyBudget({ allowanceUsd: 300, leftUsd: 30, perDropUsd: 25 })).toBe(25);
    expect(steadyBudget({ allowanceUsd: 300, leftUsd: 7, perDropUsd: 25 })).toBe(7);
  });
  it("the planner opens a small drop inside the rule instead of one big offer", async () => {
    // Stock 10 at $10 and 50% back could put $50 at risk; the rule allows $60 a week; the steady slice is $20.
    const p = await planFrom({ name: "Glow", account: account(60, 0, 50), drops: [drop(3, {}, { profitUsd: 6 })], fixtures: [match] }, model(50));
    expect(p.act).toBe("open");
    expect(p.capUsd).toBe(20);
    expect(p.spots).toBe(4);
    expect(p.capUsd!).toBeLessThanOrEqual(p.perDropLimitUsd!);
  });
  it("skips rather than asks for more when the week's slice cannot cover one buyer", async () => {
    const p = await planFrom({ name: "Glow", account: account(30, 29), drops: [drop(3)], fixtures: [match] }, model(50));
    expect(p.act).toBe("skip");
    expect(p.reason).toContain("wait for next week");
  });
});

describe("take profit and margin", () => {
  it("lowers the offer when the product sold past what the budget covered", () => {
    // $20 at 50% of $10 covered 4 buyers; 9 bought.
    const r = chooseTier(5_000, drop(9), true);
    expect(r.tier).toBe(2_500);
    expect(r.why).toContain("9 bought while the budget covered 4");
  });
  it("treats a profit equal to the price as not given, and then never goes free", () => {
    expect(knownProfit({ priceUsd: 10, profitUsd: 10 })).toBeNull();
    expect(knownProfit({ priceUsd: 10, profitUsd: undefined })).toBeNull();
    expect(knownProfit({ priceUsd: 10, profitUsd: 4 })).toBe(4);
    expect(chooseTier(10_000, undefined, false).tier).toBe(5_000);
  });
  it("keeps the buyers threshold to a third of the stock", () => {
    expect(capThreshold(10, 10)).toBe(3);
    expect(capThreshold(5, 2)).toBe(0);
    expect(capThreshold(3, 30)).toBe(3);
  });
  it("an unknown margin caps the budget at a quarter of the stock's price", async () => {
    // profitUsd equals price (the old blank cost bug): treated as unknown, so at most 10 x $10 x 25% = $25.
    const p = await planFrom({ name: "Glow", account: account(300, 0, 100), drops: [drop(3, {}, { profitUsd: 10 })], fixtures: [match] }, model(100));
    expect(p.terms!.rateA).toBe(5_000);
    expect(p.capUsd!).toBeLessThanOrEqual(25);
    expect(p.breakEvenSales).toBeNull();
  });
});
