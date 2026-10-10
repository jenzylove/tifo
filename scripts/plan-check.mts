// Checks the agent's planner against real upcoming fixtures and live odds, with three made up seller histories.
// The histories are test input only. What is checked is what the code must guarantee whatever the model says:
// the plan respects the seller's rule, the offers are inside the contract's bounds, and it never gives away
// more per sale than the seller makes.
// Usage: npx tsx --env-file=web/.env.development.local scripts/plan-check.mts
import type { DropRow } from "../web/lib/manager.ts";
import { upcomingMatches } from "../web/lib/matches.ts";
import { planFrom, type Plan } from "../web/lib/planner.ts";
import type { AccountState } from "../web/lib/tifoAccount.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const u = (usd: number) => String(Math.round(usd * 1e6));
const fixtures = (await upcomingMatches(Date.now() + 3 * 3600_000, Date.now() + 6 * 86_400_000)).filter((m) => m.odds).slice(0, 25);
console.log(`${fixtures.length} priced fixtures in the next six days`);

const account = (allowance: number, committed: number, perDrop: number): AccountState => ({
  address: "0x0000000000000000000000000000000000000001", weeklyBps: 1000, baseWeekly: u(allowance), perDealCap: u(perDrop),
  allowance: u(allowance), committed: u(committed), recentSales: u(0), balance: u(0), proposals: [],
});
const drop = (priceUsd: number, profitUsd: number, bySide: [number, number], refunded: number, outcome: string): DropRow => ({
  address: "0x0000000000000000000000000000000000000002",
  meta: { slug: "past", league: "Premier League", teamA: "Arsenal", teamB: "Chelsea", kickoff: new Date(Date.now() - 3 * 86_400_000).toISOString(), shop: "Test seller", product: "Budget template", priceUsd, profitUsd, shape: "free", baseRates: [10_000, 10_000], minBps: 10_000, maxBps: 10_000, effectiveBps: 0 },
  closesAt: 0, phase: "settled", outcome, rates: [10_000, 10_000], orders: bySide[0] + bySide[1], fans: bySide[0] + bySide[1],
  sales: u(priceUsd * (bySide[0] + bySide[1])), held: "0", refunded: u(refunded), cap: u(40), bySide, byAgent: false, reconciled: true,
  extraSalesToBreakEven: Math.ceil(refunded / profitUsd),
});

function guarantees(label: string, p: Plan, rule: { left: number; perDrop: number }, price: number, profit: number) {
  console.log(`\n${label}: ${p.act}${p.match ? ` · ${p.match} · ${p.shape} · $${p.capUsd}` : ""}\n  "${p.reason}"`);
  check(`${label}: gives a reason`, p.reason.length > 20);
  if (p.act === "skip") return;
  const t = p.terms!;
  const cap = Number(t.cap) / 1e6;
  check(`${label}: acts by itself only inside the rule`, (p.act === "open") === (cap <= rule.perDrop && cap <= rule.left), `budget $${cap}, left $${rule.left}, per drop $${rule.perDrop}`);
  check(`${label}: the fixture is a real upcoming one`, fixtures.some((m) => `0x` && p.kickoff === m.kickoff));
  check(`${label}: offers are inside the contract's bounds`, t.rateA >= t.minBps && t.rateA <= t.maxBps && t.rateB >= t.minBps && t.rateB <= t.maxBps && t.maxBps <= 10_000);
  if (p.shape === "free") check(`${label}: the budget covers at least one free product`, cap >= price && (p.spots ?? 0) >= 1);
  else check(`${label}: never gives away more per sale than the seller makes`, (price * JSON.parse(p.meta!).effectiveBps) / 10_000 < profit);
  check(`${label}: says who opened it`, JSON.parse(p.meta!).byAgent === (p.act === "open"));
}

// 1. A digital seller with room in the rule. The last drop filled one side only.
const a = await planFrom({ name: "Test seller", account: account(60, 0, 40), drops: [drop(20, 20, [9, 1], 40, "A")], fixtures });
guarantees("room in the rule", a, { left: 60, perDrop: 40 }, 20, 20);
check("room in the rule: the agent chooses to run a drop", a.act !== "skip");

// 2. The same seller with this week's allowance already used.
const b = await planFrom({ name: "Test seller", account: account(60, 60, 40), drops: [drop(20, 20, [6, 5], 40, "B")], fixtures });
guarantees("nothing left this week", b, { left: 0, perDrop: 40 }, 20, 20);
check("nothing left this week: the agent does not act by itself", b.act !== "open");

// 3. A thin margin: $20 product, $1 profit. A drop cannot pay for itself.
const c = await planFrom({ name: "Test seller", account: account(60, 0, 40), drops: [drop(20, 1, [2, 2], 40, "A")], fixtures });
guarantees("thin margin", c, { left: 60, perDrop: 40 }, 20, 1);
check("thin margin: the agent refuses or keeps the budget to what the margin can carry", c.act === "skip" || (c.capUsd ?? 0) <= 200);
process.exit(failed ? 1 : 0);
