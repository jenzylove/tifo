// The agent's own decision: should this seller run a drop now, on which match, and how big.
// The model judges and explains. Every number that moves money comes from the core math and the chain,
// and the seller's rule on their account contract decides whether the agent may act or only propose.
import Anthropic from "@anthropic-ai/sdk";
import { initialRates } from "@tifo/core";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import type { DropRow } from "./manager";
import { shortTeam, type Match } from "./matches";
import { MODEL } from "./model";
import type { PromoMeta } from "./promos";
import type { AccountState } from "./tifoAccount";

const MIN = 500, MAX = 6000, FULL = 10_000, DRAW = 500;

export interface Terms {
  fixtureId: Hex;
  closesAt: bigint;
  settleNotBefore: bigint;
  cap: bigint;
  minBps: number;
  maxBps: number;
  rateA: number;
  rateB: number;
  floorBps: number;
  drawBps: number;
}

export interface Plan {
  act: "open" | "propose" | "skip";
  reason: string; // the agent's own words; written on chain when it acts
  account?: Address;
  match?: string;
  kickoff?: string;
  shape?: "free" | "percent";
  capUsd?: number;
  offers?: [string, string];
  spots?: number;
  breakEvenSales?: number | null;
  leftThisWeekUsd?: number;
  perDropLimitUsd?: number;
  terms?: Terms;
  meta?: string;
  at: number;
}

const SYSTEM = `You are the sales manager for someone who sells online through Tifo. You run match drops for them:
fans of both teams buy the product at full price and pick a side; if their team wins they get money back in USDC.
Two offer shapes exist. "free": a full refund for the first buyers on each side, as many as the budget covers
(budget / price per side). "percent": a smaller % back for every buyer, priced from the odds.
On a draw every buyer gets 5% back. The budget is the most a drop can cost the seller, whoever wins.

Decide whether to run a drop now, and if so on which fixture, with which shape and what budget.
- You are spending the seller's money to bring them sales. A drop must be able to pay for itself:
  compare the budget to profit_per_sale. If the margin cannot carry any sensible offer, skip and say why.
- Learn from past_drops: which sides filled, what the refunds cost against sales, whether it paid for itself.
  Say in the reason what you are changing because of the last drop, or that this is the first one you are choosing.
- left_this_week_usd and per_drop_limit_usd are the seller's rule. Stay inside both when you can. If a fixture is
  worth more than the rule allows, you may ask for a bigger budget: it then goes to the seller as a proposal to approve,
  so the reason must justify it.
- Pick a fixture only from fixtures. Prefer one whose fans are likely to be this seller's buyers.
- Skip if nothing is worth it. Skipping is a decision.
reason: two or three plain sentences to the seller, quoting only numbers you were given. No betting language. No markdown.`;

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    act: { type: "string", enum: ["run", "skip"] },
    match_slug: { type: "string" },
    shape: { type: "string", enum: ["free", "percent"] },
    discount_pct: { type: "number" },
    budget_usd: { type: "number" },
    reason: { type: "string" },
  },
  required: ["act", "reason"],
};

const usdc = (units: string) => Number(units) / 1e6;

export interface PlanInput {
  name: string | null;
  account: AccountState;
  drops: DropRow[]; // newest first; the first one is the template for what the seller sells
  fixtures: Match[]; // priced fixtures the agent may choose from
}

/** Decide from what is known. Reads nothing and sends nothing. */
export async function planFrom({ name, account, drops, fixtures }: PlanInput): Promise<Plan> {
  const at = Date.now();
  const skip = (reason: string): Plan => ({ act: "skip", reason, at });
  const template = drops[0].meta;
  const left = Math.max(0, usdc(account.allowance) - usdc(account.committed));
  const perDrop = usdc(account.perDealCap);
  const price = template.priceUsd;
  const profit = template.profitUsd ?? null;
  if (!fixtures.length) return skip("No fixture with reliable odds kicks off in the next six days.");

  const context = {
    seller: name,
    product: { name: template.product, price_usd: price, profit_per_sale_usd: profit },
    rule: { left_this_week_usd: +left.toFixed(2), per_drop_limit_usd: perDrop, last_7_days_sales_usd: usdc(account.recentSales) },
    past_drops: drops.slice(0, 6).map((d) => ({
      match: `${shortTeam(d.meta.teamA)} v ${shortTeam(d.meta.teamB)}`,
      shape: d.meta.shape ?? "percent",
      budget_usd: usdc(d.cap),
      orders_by_side: d.bySide,
      sales_usd: usdc(d.sales),
      refunded_usd: usdc(d.refunded),
      result: d.outcome,
      extra_sales_needed_to_cover_refunds: d.extraSalesToBreakEven,
      opened_by: d.byAgent ? "you" : "the seller",
    })),
    fixtures: fixtures.map((m) => ({
      slug: m.slug,
      league: m.league.name,
      match: `${shortTeam(m.teamA)} v ${shortTeam(m.teamB)}`,
      kickoff_utc: m.kickoff,
      chances: { home: +m.odds!.pA.toFixed(2), draw: +m.odds!.pDraw.toFixed(2), away: +m.odds!.pB.toFixed(2) },
    })),
    now_utc: new Date().toISOString(),
  };

  const client = new Anthropic();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: JSON.stringify(context) }],
  } as Parameters<typeof client.messages.create>[0] & { stream?: false });
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no decision");
  const out = JSON.parse(text.text) as { act: "run" | "skip"; match_slug?: string; shape?: "free" | "percent"; discount_pct?: number; budget_usd?: number; reason: string };
  const reason = String(out.reason ?? "").slice(0, 900);
  if (out.act !== "run") return skip(reason || "Nothing worth running right now.");

  // From here the model's answer is only a suggestion: every figure is checked or recomputed.
  const m = fixtures.find((x) => x.slug === out.match_slug);
  if (!m?.odds) return skip("I picked a fixture I could not price, so I am not acting on it.");
  const shape = out.shape === "percent" ? "percent" : "free";
  let capUsd = Math.round(Math.min(5000, Math.max(shape === "free" ? price : 5, Number(out.budget_usd) || 0)) * 100) / 100;
  let discount = Math.min(20, Math.max(3, Math.round(Number(out.discount_pct) || 10)));
  if (shape === "percent" && profit !== null && profit > 0) {
    // Never give away more per sale than the seller makes.
    while (discount > 3 && (price * discount) / 100 >= profit) discount--;
    if ((price * discount) / 100 >= profit) return skip(`A money back offer would give away more than the $${profit.toFixed(2)} you make per sale, so I am not running one.`);
  }
  if (profit !== null && profit > 0 && capUsd / profit > 200) capUsd = Math.round(profit * 200 * 100) / 100;
  const spots = Math.floor(capUsd / price);
  if (shape === "free" && spots < 1) return skip("The budget would not cover one free product, so I am not running a free drop.");

  const rates = shape === "free" ? ([FULL, FULL] as [number, number]) : (initialRates(m.odds, discount * 100, MIN, MAX).map(Number) as [number, number]);
  const [lo, hi] = shape === "free" ? [FULL, FULL] : [MIN, MAX];
  const kickoff = Math.floor(Date.parse(m.kickoff) / 1000);
  const withinRule = capUsd <= perDrop && capUsd <= left;
  const meta: PromoMeta = {
    slug: m.slug, league: m.league.name, teamA: m.teamA, teamB: m.teamB, kickoff: m.kickoff,
    shop: template.shop, product: template.product, priceUsd: price, image: template.image, description: template.description,
    profitUsd: template.profitUsd, delivery: template.delivery, contact: template.contact,
    shape, baseRates: rates, minBps: lo, maxBps: hi, effectiveBps: shape === "free" ? 0 : discount * 100,
    byAgent: withinRule, reason,
  };
  const A = shortTeam(m.teamA), B = shortTeam(m.teamB);
  return {
    act: withinRule ? "open" : "propose",
    reason,
    account: account.address,
    match: `${A} v ${B}`,
    kickoff: m.kickoff,
    shape,
    capUsd,
    offers: shape === "free" ? [`Free if ${A} win`, `Free if ${B} win`] : [`${rates[0] / 100}% back if ${A} win`, `${rates[1] / 100}% back if ${B} win`],
    spots: shape === "free" ? spots : undefined,
    breakEvenSales: profit && profit > 0 ? Math.ceil(capUsd / profit) : null,
    leftThisWeekUsd: +left.toFixed(2),
    perDropLimitUsd: perDrop,
    terms: {
      fixtureId: keccak256(toBytes(m.slug)),
      closesAt: BigInt(kickoff),
      settleNotBefore: BigInt(kickoff + 110 * 60),
      cap: BigInt(Math.round(capUsd * 1e6)),
      minBps: lo, maxBps: hi, rateA: rates[0], rateB: rates[1], floorBps: 0, drawBps: DRAW,
    },
    meta: JSON.stringify(meta),
    at,
  };
}
