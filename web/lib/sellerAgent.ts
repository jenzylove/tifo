// The seller's sales rep. Claude picks the match and the terms; the numbers always come from
// the deterministic core math and live odds, never from the model's own arithmetic.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { initialRates } from "@tifo/core";
import { matchBySlug, upcomingMatches, shortTeam, type Match } from "./matches";

const client = new Anthropic();
export const MODEL = "claude-opus-5-5";

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

const SYSTEM = `You are Tifo, a sales rep for small online shops. You design two-sided match promos:
fans of each team in one match buy the shop's product at full price, and the winning team's fans get a
percentage back, paid automatically in USDC on Arc right after the final whistle. A draw pays no rebate.

How the money works (explain it plainly when it helps the seller decide):
- Each fan's rebate % is fixed when they buy. Underdog fans get a bigger % so every fan gets the same expected discount.
- The seller sets a cap: the most they can ever owe in refunds, whoever wins. The contract keeps just enough from each sale to cover the bigger of the two refund bills and sends the rest to the seller immediately.
- As sales come in, you shift offers toward the lighter side so the book stays balanced.

Your job in this chat:
1. Unless the seller is described below, find out what they sell, the price, a photo link of the product (optional but it makes the drop page sell), roughly how many orders they expect this week, and which teams their buyers follow (ask briefly if missing; one question at a time).
2. Use find_matches to pick a real upcoming match whose fan bases overlap the shop's audience. Only use matches that have live odds.
3. Use price_promo to test terms. Pick an expected discount (usually 5–15%) and a cap the seller is comfortable owing. Show the offers for each side and the worst case.
4. When the seller is happy, call propose_promo with the final terms. The seller then launches it with one click from their own wallet.

Rules: never invent odds, prices, or numbers — quote only what the tools return. No betting language
("bet", "wager", "odds boost", "win money"): it's a rebate on a purchase. Keep replies short and concrete. Plain text only: no markdown, no asterisks or headings.`;

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
    description: "Price a promo for one match: rebate % for each side, and what the seller could owe.",
    inputSchema: z.object({
      slug: z.string(),
      expected_discount_pct: z.number().min(1).max(30),
      cap_usd: z.number().min(5).max(5000),
      min_pct: z.number().min(1).max(50).default(5),
      max_pct: z.number().min(5).max(100).default(60),
    }),
    run: async (i) => {
      const m = await matchBySlug(i.slug);
      if (!m?.odds) return JSON.stringify({ error: m ? `cannot price: ${m.oddsProblem}` : "match not found" });
      const [ra, rb] = initialRates(m.odds, i.expected_discount_pct * 100, i.min_pct * 100, i.max_pct * 100).map(Number);
      return JSON.stringify({
        match: matchLine(m),
        offers: { [shortTeam(m.teamA)]: `${ra / 100}% back if they win`, [shortTeam(m.teamB)]: `${rb / 100}% back if they win`, draw: "no rebate" },
        worst_case_usd: i.cap_usd,
        note: "The cap is enforced on chain: once one side's refund bill reaches it, that side stops taking orders at the current %. Sales on the lighter side keep flowing.",
        example_per_100_usd_sales_each_side: {
          if_A_wins: +(ra / 100).toFixed(2),
          if_B_wins: +(rb / 100).toFixed(2),
        },
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
      expected_discount_pct: z.number().min(1).max(30),
      cap_usd: z.number().min(5).max(5000),
      min_pct: z.number().min(1).max(50).default(5),
      max_pct: z.number().min(5).max(100).default(60),
      explanation: z.string().max(600).describe("Two or three plain sentences for the seller: why this match and these terms."),
    }),
    run: async (i) => {
      const m = await matchBySlug(i.slug);
      if (!m?.odds) return JSON.stringify({ error: "cannot price this match" });
      if (Date.parse(m.kickoff) < Date.now() + 30 * 60_000) return JSON.stringify({ error: "kickoff is too close" });
      const rates = initialRates(m.odds, i.expected_discount_pct * 100, i.min_pct * 100, i.max_pct * 100).map(Number) as [number, number];
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
        effectiveBps: Math.round(i.expected_discount_pct * 100),
        capUsd: i.cap_usd,
        minBps: Math.round(i.min_pct * 100),
        maxBps: Math.round(i.max_pct * 100),
        rates,
        odds: m.odds,
        explanation: i.explanation,
      };
      return JSON.stringify({ ok: true, rates });
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
