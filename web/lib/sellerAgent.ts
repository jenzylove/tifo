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
  stock?: number;
  minBps: number;
  maxBps: number;
  rates: [number, number];
  odds: { pA: number; pB: number; pDraw: number };
  explanation: string;
}

const SYSTEM = `Write like a shop promotion, never a sportsbook: say club, fans, money back; never words like bet, odds, wager, stake, punt or pick a side.
You are Tifo, a sales rep for small online shops. You design one kind of promo, tied to a football match:
buyers choose the club they support and get a fixed share of the price back if their team wins: 25%, 50% or 100% (100% means free).
It is paid automatically in USDC on Arc after full time, once the result is confirmed.

How it works (explain it plainly when it helps the seller decide):
- The seller picks the share (25, 50 or 100% back) and says how many they have (stock).
- Every buyer gets that share back if their team wins. Nobody is left out.
- The stock caps the cost: the most it can cost is stock x price x share, if every unit sells to fans of the team that wins.
- What it usually costs is much less, because buyers split between two teams and only one can win. A 25% back offer
  usually costs about what a 10% off sale does. Say this plainly to sellers: that is why they would use it.
- Only big matches: top European leagues, the Champions League and national teams.
- On a draw every buyer gets a small thank you (5% back).
- Both sides pay full price and only one side can win, so the seller keeps most of what the drop brings in.
- The budget is the most a drop can ever cost the seller, whoever wins. A contract enforces it.

Your job in this chat:
1. Unless the seller is described below, find out what they sell, the price, the profit per sale, how many they have, and a photo link of the product (optional, it makes the drop page sell). Ask briefly if missing; one question at a time.
2. Use find_matches to pick a real upcoming match whose fan bases overlap the shop's audience.
3. Use price_promo to show the most it can cost and what it usually costs at the share they pick (suggest 25% if they have no preference), the worst case (the budget), and, when profit per sale is known, how many extra sales pay for it.
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
    description: "Show the offer for one match at 25, 50 or 100% back for every buyer: the most it can cost (from stock), what it usually costs, and how many extra sales pay for it.",
    inputSchema: z.object({
      slug: z.string(),
      stock: z.number().int().min(1).max(500).describe("How many the seller has to sell"),
      price_usd: z.number().min(1).max(10000),
      back_pct: z.union([z.literal(25), z.literal(50), z.literal(100)]).describe("Share of the price back if their team wins"),
      profit_usd: z.number().positive().optional().describe("Profit per sale in USD, if the seller said"),
    }),
    run: async (i) => {
      const m = await matchBySlug(i.slug);
      if (!m) return JSON.stringify({ error: "match not found" });
      const worst = Math.round(i.stock * i.price_usd * i.back_pct) / 100;
      const usual = m.odds ? Math.round(((worst * (m.odds.pA + m.odds.pB)) / 2) * 100) / 100 : null;
      const say = (t: string) => (i.back_pct === 100 ? `Free if ${t} win` : `${i.back_pct}% back if ${t} win`);
      return JSON.stringify({
        match: matchLine(m),
        offers: { [shortTeam(m.teamA)]: say(shortTeam(m.teamA)), [shortTeam(m.teamB)]: say(shortTeam(m.teamB)) },
        every_buyer_gets_back_if_their_team_wins: `${i.back_pct}%`,
        most_it_can_cost_usd: worst,
        usually_costs_usd: usual,
        usually_like_a_discount_of_pct: usual !== null ? Math.round((usual / (i.stock * i.price_usd)) * 100) : null,
        draw: "every buyer gets 5% back as a thank you",
        after_that: "buyers on that side pay full price with nothing back",
        ...(i.profit_usd && usual !== null ? { extra_sales_that_pay_for_the_usual_cost: Math.ceil(usual / i.profit_usd) } : {}),
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
      stock: z.number().int().min(1).max(500).describe("How many the seller has to sell"),
      back_pct: z.union([z.literal(25), z.literal(50), z.literal(100)]).describe("Share of the price back if their team wins"),
      explanation: z.string().max(600).describe("Two or three plain sentences for the seller: why this match and these terms."),
    }),
    run: async (i) => {
      const m = await matchBySlug(i.slug);
      if (!m?.odds) return JSON.stringify({ error: "cannot use this match" });
      if (Date.parse(m.kickoff) < Date.now() + 30 * 60_000) return JSON.stringify({ error: "kickoff is too close" });
      const tier = i.back_pct * 100;
      const capUsd = Math.round(i.stock * i.price_usd * i.back_pct) / 100;
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
        capUsd,
        stock: i.stock,
        minBps: tier,
        maxBps: tier,
        rates: [tier, tier],
        odds: m.odds,
        explanation: i.explanation,
      };
      return JSON.stringify({ ok: true, most_it_can_cost_usd: capUsd });
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
