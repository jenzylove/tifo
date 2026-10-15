// The agent plans a seller's drop from what they sell: which match, how much back, whether it balances the offer and
// whether the offer waits for a few buyers. The model judges and explains; code checks every choice before the seller sees it.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { isBigMatch, shortTeam, upcomingMatches, type Match } from "./matches";
import { MODEL } from "./model";

export interface DropPlanInput {
  product: string;
  priceUsd: number;
  units: number;
  kind: "digital" | "physical" | "booking";
  profitUsd?: number | null;
  shop?: string | null;
}

export interface DropPlan {
  slug: string;
  backPct: number; // 10 to 100
  balance: boolean;
  minBuyers: number; // 0, 3, 5 or 10
  reason: string;
  byModel: boolean; // false when the plan came from the fallback rule
}

const WEIGHT: Record<string, number> = {
  "Champions League": 5, "Premier League": 5, "La Liga": 4, "Serie A": 4, Bundesliga: 4, "Europa League": 3,
  "Ligue 1": 3, "UEFA Nations League": 3, International: 3, MLS: 2,
};
const REACH = [0, 3, 5, 10];

/** Matches a seller's buyers have heard of, with the sale open long enough to share the link (3 hours to 6 days). */
export async function candidates(): Promise<Match[]> {
  const now = Date.now();
  return (await upcomingMatches())
    .filter((m) => m.odds && (WEIGHT[m.league.name] ?? 0) >= 3 && isBigMatch(m.teamA, m.teamB) && Date.parse(m.kickoff) > now + 3 * 3600_000 && Date.parse(m.kickoff) < now + 6 * 86_400_000)
    .slice(0, 40);
}

const SYSTEM = `You plan a match day promo for a small online seller on Tifo. Buyers pay the normal price, pick a team, and get
back_pct of the price back if their team wins (100 means free). The seller's most possible cost is units x price x back_pct / 100.
It usually costs much less: buyers split between the teams and only one side wins.

Choose:
- match_slug: one fixture from the list. Prefer a match the seller's buyers care about (big clubs, close games bring both sides in),
  with enough time to share the link before the sale closes at kickoff, but soon enough to feel urgent (1 to 4 days is ideal).
- back_pct: a whole number from 10 to 100. Keep the most possible cost sensible against the seller's price and margin.
  50 is a strong default. 100 (free) is the boldest hook and suits cheap or digital items with high margins. 10 to 30 suits thin margins.
- balance: true lets the agent lower one side's offer for new buyers when that side runs ahead (down to half), so the cost stays
  even whoever wins. Recommend true unless the seller wants one fixed offer.
- min_buyers: 0, 3, 5 or 10. Above 0 the offer only pays out if that many people buy, which makes buyers share the link.
  Use 3 or 5 for small stock, 0 when stock is 1 or 2.
- reason: two or three short sentences to the seller in plain words: why this match, why this offer. Quote only numbers you were
  given. Say "sale ends" rather than kickoff. No betting words, no odds, no markdown.`;

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    match_slug: { type: "string" },
    back_pct: { type: "integer" },
    balance: { type: "boolean" },
    min_buyers: { type: "integer", enum: REACH },
    reason: { type: "string" },
  },
  required: ["match_slug", "back_pct", "balance", "min_buyers", "reason"],
};

/** The rule the agent falls back on when the model cannot answer: the biggest close match, 50% back, balanced. */
function fallback(input: DropPlanInput, ms: Match[]): DropPlan | null {
  const now = Date.now();
  const best = ms
    .map((m) => {
      const gap = Math.abs(m.odds!.pA - m.odds!.pB);
      const days = (Date.parse(m.kickoff) - now) / 86_400_000;
      return { m, score: (WEIGHT[m.league.name] ?? 1) + (1 - gap) * 3 - days * 0.25 };
    })
    .sort((a, b) => b.score - a.score)[0]?.m;
  if (!best) return null;
  return {
    slug: best.slug,
    backPct: 50,
    balance: true,
    minBuyers: input.units >= 6 ? 3 : 0,
    reason: `${shortTeam(best.teamA)} v ${shortTeam(best.teamB)} is the biggest close match coming up, so fans on both sides will want in. Half back if their team wins reads like a normal sale and keeps your cost even.`,
    byModel: false,
  };
}

export async function planDrop(input: DropPlanInput): Promise<DropPlan> {
  const ms = await candidates();
  if (!ms.length) throw new Error("No big match is coming up in the next six days.");
  const context = {
    seller: input.shop ?? null,
    product: { name: input.product, price_usd: input.priceUsd, units: input.units, how_delivered: input.kind, profit_per_sale_usd: input.profitUsd ?? null },
    fixtures: ms.map((m) => ({
      slug: m.slug,
      league: m.league.name,
      match: `${shortTeam(m.teamA)} v ${shortTeam(m.teamB)}`,
      sale_ends_utc: m.kickoff,
      close_game: Math.abs(m.odds!.pA - m.odds!.pB) < 0.2,
    })),
    now_utc: new Date().toISOString(),
  };
  try {
    const client = new Anthropic();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: JSON.stringify(context) }],
    } as Parameters<typeof client.messages.create>[0] & { stream?: false });
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("no plan");
    const out = JSON.parse(text.text) as { match_slug: string; back_pct: number; balance: boolean; min_buyers: number; reason: string };
    // The model's answer is a suggestion: the match must be one it was given and every number is clamped.
    const m = ms.find((x) => x.slug === out.match_slug);
    if (!m) throw new Error("unknown match");
    const backPct = Math.min(100, Math.max(10, Math.round(Number(out.back_pct) || 50)));
    let minBuyers = REACH.includes(out.min_buyers) ? out.min_buyers : 0;
    if (minBuyers > input.units) minBuyers = 0;
    return { slug: m.slug, backPct, balance: out.balance !== false, minBuyers, reason: String(out.reason ?? "").slice(0, 600), byModel: true };
  } catch (e) {
    console.error("plan-drop fell back", e);
    const f = fallback(input, ms);
    if (!f) throw e;
    return f;
  }
}
