// The AI manager's briefing: reads the shop's numbers and the coming fixtures, and says what to do next.
// Numbers come from the chain and the core math; the model only judges and explains.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { Address } from "viem";
import { managerData } from "./manager";
import { shortTeam, upcomingMatches } from "./matches";
import { MODEL } from "./sellerAgent";

const client = new Anthropic();

export interface Move {
  title: string;
  why: string;
  match_slug?: string;
  discount_pct?: number;
  cap_usd?: number;
}

export interface Brief {
  summary: string;
  moves: Move[];
  watch: string[];
  at: number;
}

const cache = new Map<string, Brief>();

const SYSTEM = `You are the AI sales manager for someone who sells online through Tifo. You look after their sales, their promo budget
and their cash, and you run match promos for them: the first buyers on each side get the full price back if their team wins
(free spots per side = budget divided by price, rounded down). After the free spots on a side are taken, buyers pay full price
with nothing back. On a draw every buyer gets 5% back as a thank you. The budget is the most a drop can cost the seller, and it is set before kickoff.

Write a short briefing for the owner, like a sharp manager would on a Monday morning:
- summary: two or three plain sentences on how the business is doing, quoting only the numbers given.
- moves: up to three concrete next moves. When a move is a promo, name the exact match_slug from the fixtures list and a
  cap_usd (the budget) the seller can afford given their sales. Do not use discount_pct. Use what the past drops show: which sides
  filled, what the free spots cost against the sales they brought, and whether the last one paid for itself. Prefer matches
  that kick off in the next few days. Other moves can be about price or the product photo.
- watch: up to three short things to keep an eye on (a drop awaiting its result, reserve held, a side running ahead).
No betting language. No invented numbers. Short sentences. Plain text, no markdown. Budgets are at least $1.`;

export async function managerBrief(seller: Address, fresh = false): Promise<Brief> {
  const key = seller.toLowerCase();
  const hit = cache.get(key);
  if (hit && !fresh && Date.now() - hit.at < 30 * 60_000) return hit;

  const [data, fixtures] = await Promise.all([managerData(seller), upcomingMatches(Date.now() + 2 * 3600_000, Date.now() + 7 * 86_400_000)]);
  const list = fixtures.filter((m) => m.odds).slice(0, 20).map((m) => {
    return { slug: m.slug, league: m.league.name, match: `${shortTeam(m.teamA)} v ${shortTeam(m.teamB)}`, kickoff_utc: m.kickoff };
  });
  const $ = (u: string) => `$${(Number(u) / 1e6).toFixed(2)}`;
  const context = {
    seller: data.name,
    totals: { sales: $(data.totals.sales), received: $(data.totals.received), held_for_refunds: $(data.totals.held), refunded_to_fans: $(data.totals.refunded), fans: data.totals.fans, orders: data.totals.orders, live_drops: data.totals.live },
    drops: data.drops.slice(0, 8).map((d) => ({ match: `${shortTeam(d.meta.teamA)} v ${shortTeam(d.meta.teamB)}`, product: d.meta.product, phase: d.phase, outcome: d.outcome, orders_by_side: d.bySide, sales: $(d.sales), held: $(d.held), refunded: $(d.refunded), profit_per_sale_usd: d.meta.profitUsd ?? null, extra_sales_needed_to_cover_refunds: d.extraSalesToBreakEven })),
    fixtures_next_7_days: list,
    now_utc: new Date().toISOString(),
  };

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      moves: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            why: { type: "string" },
            match_slug: { type: "string" },
            cap_usd: { type: "number" },
          },
          required: ["title", "why"],
        },
      },
      watch: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "moves", "watch"],
  };
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: JSON.stringify(context) }],
  } as Parameters<typeof client.messages.create>[0] & { stream?: false });
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no briefing");
  const out = JSON.parse(text.text) as Omit<Brief, "at">;
  out.moves = (out.moves ?? []).slice(0, 3);
  out.watch = (out.watch ?? []).slice(0, 3);
  // Keep only moves that point at real fixtures and real products.
  const slugs = new Set(list.map((m) => m.slug));
  out.moves = (out.moves ?? []).map((m) => (m.match_slug && !slugs.has(m.match_slug) ? { title: m.title, why: m.why } : m));
  const brief = { ...out, at: Date.now() };
  cache.set(key, brief);
  return brief;
}
