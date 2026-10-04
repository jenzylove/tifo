// The AI manager's briefing: reads the shop's numbers and the coming fixtures, and says what to do next.
// Numbers come from the chain and the core math; the model only judges and explains.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { initialRates } from "@tifo/core";
import type { Address } from "viem";
import { managerData } from "./manager";
import { shortTeam, upcomingMatches } from "./matches";
import { MODEL } from "./sellerAgent";

const client = new Anthropic();

export interface Move {
  title: string;
  why: string;
  match_slug?: string;
  product_id?: string;
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

const SYSTEM = `You are the AI business manager for a small online shop on Tifo. You look after its sales, its promo budget
and its cash, and you run match promos for it: fans of both teams buy a product at full price and the winning side's fans
get a fixed % back in USDC after full time. A draw pays no rebate. The shop's worst case is capped before kickoff.

Write a short briefing for the owner, like a sharp manager would on a Monday morning:
- summary: two or three plain sentences on how the business is doing, quoting only the numbers given.
- moves: up to three concrete next moves. When a move is a promo, name the exact match_slug from the fixtures list, the
  product_id from the catalog, an expected discount (5-15%) and a cap the shop can afford given its sales. Prefer matches
  whose fan bases overlap the shop's teams and kick off in the next few days. Other moves can be about pricing, the catalog
  or the shop page (e.g. a product with no photo).
- watch: up to three short things to keep an eye on (a drop awaiting its result, reserve held, a side running ahead).
No betting language. No invented numbers. Short sentences. Plain text, no markdown. Caps are at least $5.

export async function managerBrief(seller: Address, fresh = false): Promise<Brief> {
  const key = seller.toLowerCase();
  const hit = cache.get(key);
  if (hit && !fresh && Date.now() - hit.at < 30 * 60_000) return hit;

  const [data, fixtures] = await Promise.all([managerData(seller), upcomingMatches(Date.now() + 2 * 3600_000, Date.now() + 7 * 86_400_000)]);
  const p = data.shop?.profile;
  const teams = (p?.teams ?? []).map((t) => t.toLowerCase());
  const priced = fixtures.filter((m) => m.odds);
  const relevant = teams.length ? priced.filter((m) => teams.some((t) => m.title.toLowerCase().includes(t))) : [];
  const list = [...relevant, ...priced.filter((m) => !relevant.includes(m))].slice(0, 20).map((m) => {
    const [ra, rb] = initialRates(m.odds!, 1000, 500, 6000).map(Number);
    return { slug: m.slug, league: m.league.name, match: `${shortTeam(m.teamA)} v ${shortTeam(m.teamB)}`, kickoff_utc: m.kickoff, offers_at_10pct: `${ra / 100}% / ${rb / 100}%` };
  });
  const $ = (u: string) => `$${(Number(u) / 1e6).toFixed(2)}`;
  const context = {
    shop: p ? { name: p.name, city: p.city, teams: p.teams, catalog: p.products.map((x) => ({ product_id: x.id, name: x.name, price_usd: x.priceUsd, has_photo: !!x.image })) } : null,
    totals: { sales: $(data.totals.sales), received: $(data.totals.received), held_for_refunds: $(data.totals.held), refunded_to_fans: $(data.totals.refunded), fans: data.totals.fans, orders: data.totals.orders, live_drops: data.totals.live },
    drops: data.drops.slice(0, 8).map((d) => ({ match: `${shortTeam(d.meta.teamA)} v ${shortTeam(d.meta.teamB)}`, product: d.meta.product, phase: d.phase, outcome: d.outcome, orders_by_side: d.bySide, offers_now: d.rates.map((r) => `${r / 100}%`), sales: $(d.sales), held: $(d.held), refunded: $(d.refunded) })),
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
            product_id: { type: "string" },
            discount_pct: { type: "number" },
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
  const ids = new Set(p?.products.map((x) => x.id));
  out.moves = (out.moves ?? []).map((m) => (m.match_slug && (!slugs.has(m.match_slug) || (m.product_id && !ids.has(m.product_id))) ? { title: m.title, why: m.why } : m));
  const brief = { ...out, at: Date.now() };
  cache.set(key, brief);
  return brief;
}
