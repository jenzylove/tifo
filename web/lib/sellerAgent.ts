// The seller's sales rep. Claude picks the match and the terms; the numbers always come from
// the deterministic core math and live odds, never from the model's own arithmetic.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { matchBySlug, upcomingMatches, shortTeam, type Match } from "./matches";

const client = new Anthropic();
import { MODEL } from "./model";
export { MODEL };

export interface Proposal {
  slug: string;
  league: string;
  teamA: string;
  teamB: string;
  kickoff: string;
  shop: string;
  product: string;
  priceUsd: number;
  link?: string;
  image?: string;
  description?: string;
  effectiveBps: number;
  capUsd: number;
  minBps: number;
  maxBps: number;
  rates: [number, number];
  odds: { pA: number; pB: number; pDraw: number };
  explanation: string;
}

const SYSTEM = `You are Tifo, a sales rep for small online shops. You design one kind of promo, tied to a football match:
buyers pick a side and get a fixed share of the price back if their team wins: 25%, 50% or 100% (100% means free).
It is paid automatically in USDC on Arc after full time, once the result is confirmed.

How it works (explain it plainly when it helps the seller decide):
- The seller picks the share (25, 50 or 100% back) and a budget.
- Buyers covered per side = the budget divided by (price x share), rounded down. The first buyers on each side are covered.
- After that, buyers on that side pay full price with nothing back. Buyers only see a count when the last 2 are left.
- Lower shares cover more buyers for the same budget and read like a normal sale. 100% is the strongest hook but covers the fewest.
- On a draw every buyer gets a small thank you (5% back).
- Both sides pay full price and only one side can win, so the seller keeps most of what the drop brings in.
- The budget is the most a drop can ever cost the seller, whoever wins. A contract enforces it.

Your job in this chat:
1. Unless the seller is described below, find out what they sell, the price, the profit per sale, a photo link of the product (optional, it makes the drop page sell), and a budget they are comfortable spending (ask briefly if missing; one question at a time).
2. Use find_matches to pick a real upcoming match whose fan bases overlap the shop's audience.
3. Use price_promo to show the buyers covered per side at the share they pick (suggest 50% if they have no preference), the worst case (the budget), and, when profit per sale is known, how many extra sales pay for it.
4. When the seller is happy, call propose_promo with the final terms. The seller then launches it with one click from their own wallet.

Rules: never invent prices or numbers, quote only what the tools return. No betting language ("bet", "wager", "odds boost", "win money"): it is a purchase with money back if your team wins. Keep replies short and concrete. Plain text only: no markdown, no asterisks or headings.`;

function matchLine(m: Match) {
  const o = m.odds;
  return {
    slug: m.slug,
    league: m.league.name,
    match: `${shortTeam(m.teamA)} v ${shortTeam(m.teamB)}`,
    kickoff_utc: m.kickoff,
    chances: o ? { [shortTeam(m.teamA)]: +o.pA.toFixed(3), draw: +o.pDraw.toFixed(3), [shortTeam(m.teamB)]: +o.pB.toFixed(3) } : null,
    priceable: !!o,
    problem: m.oddsProblem,
  };
}

export interface SellerContext {
  name: string;
  pastDrops: { match: string; product: string; priceUsd: number; ordersBySide: [number, number]; sales: string; refunded: string; outcome: string }[];
}

function sellerContext(c: SellerContext | null) {
  if (!c) return "";
  return `\n\nYou already work with this seller (${c.name}), so don't ask for what's here. Their past drops, newest first:
${c.pastDrops.map((d) => `- ${d.match}: ${d.product} at $${d.priceUsd}, orders ${d.ordersBySide[0]} v ${d.ordersBySide[1]}, sales ${d.sales}, refunded ${d.refunded}, result ${d.outcome}`).join("\n") || "- none yet"}
Use what happened last time when you choose the next match and terms, and say so in one sentence.`;
}

export async function runSellerChat(history: Anthropic.Beta.BetaMessageParam[], seller: SellerContext | null = null): Promise<{ reply: string; proposal?: Proposal }> {
  let proposal: Proposal | undefined;

  const findMatches = betaZodTool({
    name: "find_matches",
    description: "List upcoming football matches with live market odds. Filter by a team or league name.",
    inputSchema: z.object({
      query: z.string().optional().describe("Team or league to look for, e.g. 'Arsenal' or 'Premier League'"),
      days_ahead: z.number().int().min(1).max(14).optional(),
    }),
    run: async ({ query, days_ahead }) => {
      const all = await upcomingMatches(Date.now() + 60 * 60_000, Date.now() + (days_ahead ?? 10) * 86_400_000);
      const q = (query ?? "").toLowerCase();
      const hits = all.filter((m) => !q || m.title.toLowerCase().includes(q) || m.league.name.toLowerCase().includes(q));
      return JSON.stringify((hits.length ? hits : all).slice(0, 15).map(matchLine));
    },
  });

  const pricePromo = betaZodTool({
    name: "price_promo",
    description: "Show the offer for one match at 25, 50 or 100% back: buyers covered per side, the worst case, and how many extra sales pay for it.",
    inputSchema: z.object({
      slug: z.string(),
      budget_usd: z.number().min(1).max(5000),
      price_usd: z.number().min(1).max(10000),
      back_pct: z.union([z.literal(25), z.literal(50), z.literal(100)]).describe("Share of the price back if their team wins"),
      profit_usd: z.number().positive().optional().describe("Profit per sale in USD, if the seller said"),
    }),
    run: async (i) => {
      const m = await matchBySlug(i.slug);
      if (!m) return JSON.stringify({ error: "match not found" });
      const spots = Math.floor(i.budget_usd / ((i.price_usd * i.back_pct) / 100) + 1e-9);
      if (spots < 1) return JSON.stringify({ error: "the budget does not cover even one buyer at this share" });
      const say = (t: string) => (i.back_pct === 100 ? `Free if ${t} win` : `${i.back_pct}% back if ${t} win`);
      return JSON.stringify({
        match: matchLine(m),
        offers: { [shortTeam(m.teamA)]: say(shortTeam(m.teamA)), [shortTeam(m.teamB)]: say(shortTeam(m.teamB)) },
        buyers_covered_per_side: spots,
        worst_case_usd: i.budget_usd,
        draw: "every buyer gets 5% back as a thank you",
        after_that: "buyers on that side pay full price with nothing back",
        ...(i.profit_usd ? { extra_sales_to_break_even: Math.ceil(i.budget_usd / i.profit_usd) } : {}),
      });
    },
  });

  const propose = betaZodTool({
    name: "propose_promo",
    description: "Finalize the promo terms for the seller to launch. Call once the seller agrees.",
    inputSchema: z.object({
      slug: z.string(),
      shop: z.string().min(1).max(60).describe("The seller's name as buyers know it"),
      product: z.string().min(1).max(80),
      price_usd: z.number().min(1).max(10000),
      link: z.string().url().optional(),
      image_url: z.string().url().optional().describe("Direct link to a photo of the product, if the seller gave one"),
      cap_usd: z.number().min(1).max(5000).describe("The budget: the most the drop can cost the seller"),
      back_pct: z.union([z.literal(25), z.literal(50), z.literal(100)]).describe("Share of the price back if their team wins"),
      explanation: z.string().max(600).describe("Two or three plain sentences for the seller: why this match and these terms."),
    }),
    run: async (i) => {
      const m = await matchBySlug(i.slug);
      if (!m?.odds) return JSON.stringify({ error: "cannot use this match" });
      if (Date.parse(m.kickoff) < Date.now() + 30 * 60_000) return JSON.stringify({ error: "kickoff is too close" });
      const tier = i.back_pct * 100;
      const spots = Math.floor(i.cap_usd / ((i.price_usd * i.back_pct) / 100) + 1e-9);
      if (spots < 1) return JSON.stringify({ error: "the budget does not cover even one buyer at this share" });
      proposal = {
        slug: m.slug,
        league: m.league.name,
        teamA: m.teamA,
        teamB: m.teamB,
        kickoff: m.kickoff,
        shop: i.shop,
        product: i.product,
        priceUsd: i.price_usd,
        link: i.link,
        image: i.image_url,
        effectiveBps: tier, // the share back; the drop form turns it into its tier
        capUsd: i.cap_usd,
        minBps: tier,
        maxBps: tier,
        rates: [tier, tier],
        odds: m.odds,
        explanation: i.explanation,
      };
      return JSON.stringify({ ok: true, buyers_covered_per_side: spots });
    },
  });

  const params = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM + sellerContext(seller),
    tools: [findMatches, pricePromo, propose],
    messages: history,
    output_config: { effort: "medium" },
    max_iterations: 8,
    // Server-side fallback on refusal, routed by category.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
  const final = await client.beta.messages.toolRunner(params as Parameters<typeof client.beta.messages.toolRunner>[0]);
  if (final.stop_reason === "refusal") return { reply: "I can't help with that request." };
  const reply = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { reply, proposal };
}
