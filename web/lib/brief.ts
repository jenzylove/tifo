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
and their cash, and you run match promos for them: buyers get 25%, 50% or 100% of the price back if their team wins,
for as many buyers per side as the budget covers. After that, buyers pay full price with nothing back. On a draw every buyer gets 5% back as a thank you. The budget is the most a drop can cost the seller, and it is set before kickoff.

Write a very short briefing for a busy seller reading on a phone. Fewer words always wins.
- summary: ONE sentence, at most 18 words. The single most useful fact, with one number.
- moves: at most TWO. title: at most 6 words, an action ("Share the Lille link today"). why: ONE sentence, at most 16 words.
  When a move is a promo, give the exact match_slug from the fixtures list and cap_usd (the budget). Do not use discount_pct.
- watch: at most ONE item, at most 10 words, or an empty list.
Plain words only. Never explain how the mechanism works; the seller already knows. No betting language. No invented numbers. No markdown.`;

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
  out.moves = (out.moves ?? []).slice(0, 2);
  out.watch = (out.watch ?? []).slice(0, 1);
  // Keep only moves that point at real fixtures and real products.
  const slugs = new Set(list.map((m) => m.slug));
  out.moves = (out.moves ?? []).map((m) => (m.match_slug && !slugs.has(m.match_slug) ? { title: m.title, why: m.why } : m));
  const brief = { ...out, at: Date.now() };
  cache.set(key, brief);
  return brief;
}
