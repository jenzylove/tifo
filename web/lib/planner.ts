// The agent's own decision: should this seller run a drop now, on which match, and how big.
// The model judges and explains. Every number that moves money comes from the core math and the chain,
// and the seller's rule on their account contract decides whether the agent may act or only propose.
import Anthropic from "@anthropic-ai/sdk";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import type { DropRow } from "./manager";
import { isBigMatch, shortTeam, type Match } from "./matches";
import { MODEL } from "./model";
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
  at: number;
}

const SYSTEM = `You are the sales manager for someone who sells online through Tifo. You run match drops for them:
fans of both teams buy the product at full price and pick a side; if their team wins they get money back in USDC.
The offer is the same for every buyer: a fixed share of the price back if their team wins. back_pct is 25, 50 or 100 (100 means free).
The seller's stock caps the cost: the most a drop can cost is stock x price x back_pct / 100, if every unit sells to fans of the
winning team. What it usually costs is far less, because buyers split between two teams and only one can win.
On a draw every buyer gets 5% back as a small thank you.

Decide whether to run a drop now, and if so on which fixture and at which back_pct. When the seller's stock is known, the budget
is set by the stock and back_pct; pick the highest back_pct whose cap fits the seller's rule. Otherwise give budget_usd.
- Choosing back_pct: 100 is the strongest hook but covers the fewest buyers. 25 or 50 covers more buyers for the same
  budget and reads like a normal sale. Prefer 50 unless past_drops show a reason to change, and say why you chose it.
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
    back_pct: { type: "integer", enum: [25, 50, 100] },
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
const BIG = new Set(["Premier League", "Champions League", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "Europa League", "UEFA Nations League", "International"]);

export async function planFrom({ name, account, drops, fixtures }: PlanInput): Promise<Plan> {
  const at = Date.now();
  const skip = (reason: string): Plan => ({ act: "skip", reason, at });
  const template = drops[0].meta;
  // A bookable service needs the seller's own free times, which only they know. The agent does not invent them.
  if (template.slots?.length) return skip("Your last drop was a booking, and new times have to come from you. Make the next one with the times you are free.");
  const left = Math.max(0, usdc(account.allowance) - usdc(account.committed));
  const perDrop = usdc(account.perDealCap);
  const price = template.priceUsd;
  const profit = template.profitUsd ?? null;
  // Only matches ordinary buyers have heard of.
  fixtures = fixtures.filter((m) => BIG.has(m.league.name) && isBigMatch(m.teamA, m.teamB));
  if (!fixtures.length) return skip("No big match with reliable odds kicks off in the next six days.");

  const context = {
    seller: name,
    product: { name: template.product, price_usd: price, profit_per_sale_usd: profit, stock: template.stock ?? null },
    rule: { left_this_week_usd: +left.toFixed(2), per_drop_limit_usd: perDrop, last_7_days_sales_usd: usdc(account.recentSales) },
    past_drops: drops.slice(0, 6).map((d) => ({
      match: `${shortTeam(d.meta.teamA)} v ${shortTeam(d.meta.teamB)}`,
      back_pct: d.meta.backBps ? d.meta.backBps / 100 : d.meta.shape === "free" ? 100 : null,
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
  const out = JSON.parse(text.text) as { act: "run" | "skip"; match_slug?: string; back_pct?: number; budget_usd?: number; reason: string };
  const reason = String(out.reason ?? "").slice(0, 900);
  if (out.act !== "run") return skip(reason || "Nothing worth running right now.");

  // From here the model's answer is only a suggestion: every figure is checked or recomputed.
  const m = fixtures.find((x) => x.slug === out.match_slug);
  if (!m?.odds) return skip("I picked a fixture I could not price, so I am not acting on it.");
  // Only the three round tiers exist. Anything else falls back to 50%.
  const tier = ([2_500, 5_000, 10_000] as number[]).includes(Number(out.back_pct) * 100) ? Number(out.back_pct) * 100 : 5_000;
  const shape: "free" | "back" = tier >= FULL ? "free" : "back";
  const perBuyer = (price * tier) / FULL; // what one covered buyer costs the seller if their team wins
  const stock = template.stock && template.stock > 0 ? template.stock : null;
  // With a stock count the cap follows from it; without one, the model's budget is used.
  let capUsd = Math.round(Math.min(5000, Math.max(perBuyer, stock ? stock * perBuyer : Number(out.budget_usd) || 0)) * 100) / 100;
  if (profit !== null && profit > 0 && capUsd / profit > 200) capUsd = Math.round(profit * 200 * 100) / 100;
  const spots = Math.floor(capUsd / perBuyer + 1e-9);
  if (spots < 1) return skip(`The budget would not cover even one buyer at ${tier / 100}% back, so I am not running a drop.`);

  const rates = [tier, tier] as [number, number];
  const [lo, hi] = [tier, tier];
  const kickoff = Math.floor(Date.parse(m.kickoff) / 1000);
  const withinRule = capUsd <= perDrop && capUsd <= left;
  const meta: PromoMeta = {
    slug: m.slug, league: m.league.name, teamA: m.teamA, teamB: m.teamB, kickoff: m.kickoff,
    shop: template.shop, product: template.product, priceUsd: price, image: template.image, description: template.description,
    profitUsd: template.profitUsd, delivery: template.delivery, contact: template.contact, minBuyers: template.minBuyers,
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
    breakEvenSales: profit && profit > 0 ? Math.ceil(capUsd / profit) : null,
    leftThisWeekUsd: +left.toFixed(2),
    perDropLimitUsd: perDrop,
    terms: {
      fixtureId: keccak256(toBytes(m.slug)),
      closesAt: BigInt(kickoff),
      settleNotBefore: BigInt(kickoff + 110 * 60),
      cap: BigInt(Math.round(capUsd * 1e6)),
      minBps: lo, maxBps: hi, rateA: rates[0], rateB: rates[1], floorBps: 0, drawBps: DRAW,
      holdSecs: template.delivery ? 0 : HOLD_SECS,
      minBuyers: stock && (template.minBuyers ?? 0) > stock ? 0 : (template.minBuyers ?? 0),
      minAmount: BigInt(Math.round(price * 1e6)),
    },
    meta: JSON.stringify(meta),
    at,
  };
}
