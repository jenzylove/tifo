// The agent's own decision: should this seller run a drop now, on which match, and how big.
// The model judges and explains. Every number that moves money comes from the core math and the chain,
// and the seller's rule on their account contract decides whether the agent may act or only propose.
// The portfolio rules (lib/portfolio.ts) sit on top: a steady slice of the weekly rule per drop, a stop after empty
// drops, and less offer where the product sells without it.
import Anthropic from "@anthropic-ai/sdk";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import type { DropRow } from "./manager";
import { isBigMatch, shortTeam, type Match } from "./matches";
import { MODEL } from "./model";
import { bestTemplate, capThreshold, chooseTier, clubsThatSold, knownProfit, marginCap, spotsOf, steadyBudget, stopLoss, tierOf, type Advice } from "./portfolio";
import type { PromoMeta } from "./promos";
import type { AccountState } from "./tifoAccount";

const FULL = 10_000, DRAW = 500;
const HOLD_SECS = 7 * 86_400; // physical products: the seller is paid on delivery, or 7 days after marking it sent

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
  holdSecs: number; // 0 for digital products; otherwise payment waits for delivery
  minBuyers: number; // the offer only pays out once this many people bought; 0 is from the first sale
  minAmount: bigint; // the least one order may pay: the price of one unit, in USDC units
  refNeeded: number; // friends a buyer must bring for a free order; 0 for no referrals
}

export interface Plan {
  act: "open" | "propose" | "skip";
  reason: string; // the agent's own words; written on chain when it acts
  account?: Address;
  match?: string;
  kickoff?: string;
  shape?: "free" | "back";
  capUsd?: number;
  offers?: [string, string];
  spots?: number;
  breakEvenSales?: number | null;
  leftThisWeekUsd?: number;
  perDropLimitUsd?: number;
  terms?: Terms;
  meta?: string;
  halted?: boolean; // the agent stopped opening drops after empty ones
  advice?: Advice[]; // what it proposes the seller changes instead
  at: number;
}

const SYSTEM = `You are the sales manager for someone who sells online through Tifo. You run match drops for them:
fans of both teams buy the product at full price and choose the club they support; if their team wins they get money back in USDC.
The offer is the same for every buyer: a fixed share of the price back if their team wins. back_pct is 25, 50 or 100 (100 means free).
What it usually costs is far less than the budget, because buyers split between two teams and only one can win.
On a draw every buyer gets 5% back as a small thank you.

You run the seller's drops like a careful portfolio. The budget per drop is fixed by code: a steady slice of the seller's
weekly rule (steady_budget_usd), never one big offer. You decide whether to run a drop now, on which fixture, and at which back_pct.
- Choosing back_pct: 100 is the strongest hook but covers the fewest buyers. 25 or 50 covers more buyers for the same
  budget and reads like a normal sale. Prefer 50 unless past_drops show a reason to change, and say why you chose it.
- After a drop that sold nothing, never raise back_pct: the offer is rarely why nobody bought; reach is.
- When a drop sold more orders than its budget covered, buyers came without the offer: choose a lower back_pct.
- profit_per_sale_usd may be null: the seller did not say what one costs them. Then treat the margin as thin and do not go free.
- Learn from past_drops and clubs_that_sold: prefer fixtures with clubs whose fans already bought, and the product that sold.
  Say in the reason what you are changing because of the last drop, or that this is the first one you are choosing.
- Pick a fixture only from fixtures. Prefer one whose fans are likely to be this seller's buyers.
- Skip if nothing is worth it. Skipping is a decision.
reason: two or three plain sentences to the seller, quoting only numbers you were given. No betting language (never odds, bet, stake, wager). No dashes or hyphens. No markdown.`;

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    act: { type: "string", enum: ["run", "skip"] },
    match_slug: { type: "string" },
    back_pct: { type: "integer", enum: [25, 50, 100] },
    budget_usd: { type: "number" },
    reason: { type: "string" },
  },
  required: ["act", "reason"],
};

const usdc = (units: string) => Number(units) / 1e6;

export interface ModelDecision {
  act: "run" | "skip";
  match_slug?: string;
  back_pct?: number;
  budget_usd?: number;
  reason: string;
}

export interface PlanInput {
  name: string | null;
  account: AccountState;
  drops: DropRow[]; // newest first
  fixtures: Match[]; // priced fixtures the agent may choose from
  customers?: number; // how many customers the seller saved, for the advice after empty drops
}

/** Asks the model. Replaceable in tests. */
export type Ask = (context: unknown) => Promise<ModelDecision>;

const askClaude: Ask = async (context) => {
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
  return JSON.parse(text.text) as ModelDecision;
};

/** Reasons go on chain and to the seller: no dashes, whatever the model wrote. */
const clean = (s: string) => s.replace(/\s*[‒-―]\s*/g, ", ").replace(/(\w)-(\w)/g, "$1 $2").replace(/\s+/g, " ").trim();

const BIG = new Set(["Premier League", "Champions League", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "Europa League", "UEFA Nations League", "International"]);

/** Decide from what is known. Reads nothing and sends nothing. */
export async function planFrom({ name, account, drops, fixtures, customers = 0 }: PlanInput, ask: Ask = askClaude): Promise<Plan> {
  const at = Date.now();
  const skip = (reason: string): Plan => ({ act: "skip", reason, at });

  // Stop loss: after empty drops the agent proposes a change instead of spending again.
  const stop = stopLoss(drops, customers);
  if (stop.halted) return { act: "skip", reason: stop.reason, halted: true, advice: stop.advice, at };

  // Start from the product that converted, not just the newest one.
  const template = bestTemplate(drops).meta;
  // A bookable service needs the seller's own free times, which only they know. The agent does not invent them.
  if (template.slots?.length) return skip("Your last drop was a booking, and new times have to come from you. Make the next one with the times you are free.");
  const allowance = usdc(account.allowance);
  const left = Math.max(0, allowance - usdc(account.committed));
  const perDrop = usdc(account.perDealCap);
  const steady = steadyBudget({ allowanceUsd: allowance, leftUsd: left, perDropUsd: perDrop });
  const price = template.priceUsd;
  const profit = knownProfit(template);
  const stock = template.stock && template.stock > 0 ? template.stock : null;
  if (steady < (price * 2_500) / FULL)
    return skip(`Your rule has $${left.toFixed(2)} left this week, not enough to cover even one buyer at 25% back. I will wait for next week instead of asking for more.`);
  // Only matches ordinary buyers have heard of.
  fixtures = fixtures.filter((m) => BIG.has(m.league.name) && isBigMatch(m.teamA, m.teamB));
  if (!fixtures.length) return skip("No big match with reliable odds kicks off in the next six days.");
  const sameProduct = drops.filter((d) => d.meta.product.trim().toLowerCase() === template.product.trim().toLowerCase());
  const last = sameProduct.find((d) => d.phase === "settled");

  const context = {
    seller: name,
    product: { name: template.product, price_usd: price, profit_per_sale_usd: profit, stock },
    rule: { left_this_week_usd: +left.toFixed(2), per_drop_limit_usd: perDrop, steady_budget_usd: steady, last_7_days_sales_usd: usdc(account.recentSales) },
    clubs_that_sold: clubsThatSold(drops.slice(0, 10)),
    past_drops: drops.slice(0, 6).map((d) => ({
      product: d.meta.product,
      match: `${shortTeam(d.meta.teamA)} v ${shortTeam(d.meta.teamB)}`,
      back_pct: tierOf(d.meta) / 100,
      budget_usd: usdc(d.cap),
      buyers_budget_covered: spotsOf(d),
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

  const out = await ask(context);
  let reason = clean(String(out.reason ?? "")).slice(0, 700);
  if (out.act !== "run") return skip(reason || "Nothing worth running right now.");

  // From here the model's answer is only a suggestion: every figure is checked or recomputed.
  const m = fixtures.find((x) => x.slug === out.match_slug);
  if (!m?.odds) return skip("I picked a fixture I could not price, so I am not acting on it.");
  const picked = chooseTier(Number(out.back_pct) * 100, last, profit !== null);
  let tier = picked.tier;
  if (picked.why) reason = `${reason} ${picked.why}`.trim();
  // The budget is the steady slice, also held under the stock and the margin.
  const room = Math.min(steady, marginCap(price, stock, profit) ?? Infinity);
  let perBuyer = (price * tier) / FULL;
  if (room < perBuyer && tier > 2_500) {
    tier = 2_500;
    perBuyer = (price * tier) / FULL;
    reason = `${reason} This week's slice only covers buyers at 25% back, so that is the offer.`;
  }
  let capUsd = Math.floor(Math.min(5000, room, stock ? stock * perBuyer : room) * 100) / 100;
  const spots = Math.floor(capUsd / perBuyer + 1e-9);
  if (spots < 1) return skip(`This week's steady slice of $${steady.toFixed(2)} would not cover even one buyer at ${tier / 100}% back, so I am not running a drop.`);
  capUsd = Math.round(spots * perBuyer * 100) / 100; // no budget beyond the buyers it covers
  const shape: "free" | "back" = tier >= FULL ? "free" : "back";
  reason = reason.slice(0, 900);

  const rates = [tier, tier] as [number, number];
  const [lo, hi] = [tier, tier];
  const kickoff = Math.floor(Date.parse(m.kickoff) / 1000);
  const withinRule = capUsd <= perDrop && capUsd <= left;
  const minBuyers = capThreshold(template.minBuyers ?? 0, stock);
  const meta: PromoMeta = {
    slug: m.slug, league: m.league.name, teamA: m.teamA, teamB: m.teamB, kickoff: m.kickoff,
    shop: template.shop, product: template.product, priceUsd: price, image: template.image, description: template.description,
    profitUsd: profit ?? undefined, delivery: template.delivery, contact: template.contact, minBuyers: minBuyers || undefined, refNeeded: template.delivery ? template.refNeeded : undefined,
    shape, backBps: tier, stock: stock ?? undefined, baseRates: rates, minBps: lo, maxBps: hi, effectiveBps: shape === "free" ? 0 : tier,
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
    offers: shape === "free" ? [`Free if ${A} win`, `Free if ${B} win`] : [`${tier / 100}% back if ${A} win`, `${tier / 100}% back if ${B} win`],
    spots,
    breakEvenSales: profit ? Math.ceil(capUsd / profit) : null,
    leftThisWeekUsd: +left.toFixed(2),
    perDropLimitUsd: perDrop,
    terms: {
      fixtureId: keccak256(toBytes(m.slug)),
      closesAt: BigInt(kickoff),
      settleNotBefore: BigInt(kickoff + 110 * 60),
      cap: BigInt(Math.round(capUsd * 1e6)),
      minBps: lo, maxBps: hi, rateA: rates[0], rateB: rates[1], floorBps: 0, drawBps: DRAW,
      holdSecs: template.delivery ? 0 : HOLD_SECS,
      minBuyers,
      minAmount: BigInt(Math.round(price * 1e6)),
      refNeeded: template.delivery ? Math.min(10, template.refNeeded ?? 0) : 0,
    },
    meta: JSON.stringify(meta),
    at,
  };
}
