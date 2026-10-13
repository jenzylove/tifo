// Upcoming matches and live odds from Polymarket's public API (read-only; trading is not used).
import { normalizeOdds, type Odds } from "@tifo/core";

export interface League {
  prefix: string; // Polymarket slug prefix
  name: string;
  espn: string; // ESPN soccer league slug
  durationMin: number; // kickoff to the earliest possible full time, plus stoppage margin
}

// Only leagues where at least two independent result sources cover the match.
export const LEAGUES: League[] = [
  { prefix: "epl", name: "Premier League", espn: "eng.1", durationMin: 110 },
  { prefix: "lal", name: "La Liga", espn: "esp.1", durationMin: 110 },
  { prefix: "sea", name: "Serie A", espn: "ita.1", durationMin: 110 },
  { prefix: "bun", name: "Bundesliga", espn: "ger.1", durationMin: 110 },
  { prefix: "fl1", name: "Ligue 1", espn: "fra.1", durationMin: 110 },
  { prefix: "ucl", name: "Champions League", espn: "uefa.champions", durationMin: 110 },
  { prefix: "uel", name: "Europa League", espn: "uefa.europa", durationMin: 110 },
  { prefix: "mls", name: "MLS", espn: "usa.1", durationMin: 110 },
  { prefix: "wsl", name: "Women's Super League", espn: "eng.w.1", durationMin: 110 },
  { prefix: "uslc", name: "USL Championship", espn: "usa.usl.1", durationMin: 110 },
  { prefix: "argpn", name: "Primera Nacional", espn: "arg.2", durationMin: 110 },
  { prefix: "unl", name: "UEFA Nations League", espn: "uefa.nations", durationMin: 110 },
  { prefix: "conl", name: "Concacaf Nations League", espn: "concacaf.nations.league", durationMin: 110 },
  { prefix: "fif", name: "International", espn: "fifa.friendly", durationMin: 110 },
  { prefix: "nwsl", name: "NWSL", espn: "usa.nwsl", durationMin: 110 },
];

const SOCCER_TAG_ID = "100350";

export interface Match {
  slug: string; // Polymarket event slug; also the on-chain fixture id (keccak256 of it)
  league: League;
  title: string;
  teamA: string; // home
  teamB: string; // away
  kickoff: string; // ISO
  prices: { a: number; draw: number; b: number };
  liquidityUsd: number;
  odds: Odds | null; // null when the market is too thin or broken to price from
  oddsProblem?: string;
}

const GAMMA = "https://gamma-api.polymarket.com";

interface GammaMarket {
  groupItemTitle?: string;
  outcomePrices?: string;
  gameStartTime?: string;
  sportsMarketType?: string;
}
interface GammaEvent {
  slug: string;
  title: string;
  endDate: string;
  liquidity?: number | string;
  closed?: boolean;
  markets?: GammaMarket[];
}

export function parseEvent(e: GammaEvent): Match | null {
  const prefix = e.slug.split("-")[0];
  const league = LEAGUES.find((l) => l.prefix === prefix);
  if (!league || !e.title.includes(" vs. ") || e.title.includes(" - ")) return null;
  const [teamA, teamB] = e.title.split(" vs. ").map((s) => s.trim());
  const markets = e.markets ?? [];
  const yes = (m?: GammaMarket) => (m?.outcomePrices ? Number(JSON.parse(m.outcomePrices)[0]) : NaN);
  const draw = markets.find((m) => (m.groupItemTitle ?? "").startsWith("Draw"));
  const a = markets.find((m) => m.groupItemTitle === teamA);
  const b = markets.find((m) => m.groupItemTitle === teamB);
  if (!a || !b || !draw) return null;
  const kickoff = a.gameStartTime ? new Date(a.gameStartTime.replace(" ", "T").replace("+00", "Z")).toISOString() : e.endDate;
  const prices = { a: yes(a), draw: yes(draw), b: yes(b) };
  const liquidityUsd = Number(e.liquidity ?? 0);
  let odds: Odds | null = null;
  let oddsProblem: string | undefined;
  try {
    odds = normalizeOdds(prices, liquidityUsd);
  } catch (err) {
    oddsProblem = (err as Error).message;
  }
  return { slug: e.slug, league, title: e.title, teamA, teamB, kickoff, prices, liquidityUsd, odds, oddsProblem };
}

interface GammaMarketWithEvent extends GammaMarket {
  events?: GammaEvent[];
}

/**
 * Upcoming matches in supported leagues, kicking off between `fromMs` and `toMs`.
 * Reads only the three moneyline markets per match (win / draw / win), which keeps the feed small.
 */
export async function upcomingMatches(fromMs = Date.now() + 30 * 60_000, toMs = Date.now() + 10 * 86_400_000): Promise<Match[]> {
  const min = new Date(fromMs).toISOString();
  const max = new Date(toMs + 6 * 3600_000).toISOString();
  const byEvent = new Map<string, { event: GammaEvent; markets: GammaMarket[] }>();
  for (let offset = 0; offset < 1500; offset += 100) {
    const r = await fetch(
      `${GAMMA}/markets?closed=false&sports_market_types=moneyline&tag_id=${SOCCER_TAG_ID}&limit=100&offset=${offset}&end_date_min=${min}&end_date_max=${max}`,
      { cache: "no-store" },
    );
    if (!r.ok) break;
    const page = (await r.json()) as GammaMarketWithEvent[];
    for (const m of page) {
      const e = m.events?.[0];
      if (!e) continue;
      const entry = byEvent.get(e.slug) ?? { event: e, markets: [] };
      entry.markets.push(m);
      byEvent.set(e.slug, entry);
    }
    if (page.length < 100) break;
  }
  const out: Match[] = [];
  for (const { event, markets } of byEvent.values()) {
    const m = parseEvent({ ...event, markets });
    if (!m) continue;
    const t = Date.parse(m.kickoff);
    if (t >= fromMs && t <= toMs) out.push(m);
  }
  return out.sort((x, y) => Date.parse(x.kickoff) - Date.parse(y.kickoff));
}

export async function matchBySlug(slug: string): Promise<Match | null> {
  const r = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`, { cache: "no-store" });
  if (!r.ok) return null;
  const [e] = (await r.json()) as GammaEvent[];
  return e ? parseEvent(e) : null;
}

// Names the way fans say them.
const NICK: Record<string, string> = {
  "manchester united": "Man United", "manchester city": "Man City", "tottenham hotspur": "Spurs", "tottenham": "Spurs",
  "united states": "USA", "wolverhampton wanderers": "Wolves", "brighton and hove albion": "Brighton", "newcastle united": "Newcastle",
  "west ham united": "West Ham", "nottingham forest": "Forest", "paris saint-germain": "PSG", "internazionale": "Inter",
};
export function shortTeam(name: string): string {
  const base = name.replace(/\b(FC|AFC|CF|SC|FK|SK|AC|SSC|CD|CA|WFC|W\.F\.C\.)\b/g, "").replace(/\s+/g, " ").trim();
  return NICK[base.toLowerCase()] ?? base;
}

// Clubs and national teams ordinary buyers follow. A match is only suggested when at least one side is on this list,
// so a wig seller's customers recognise it at a glance.
const FAMOUS = [
  "manchester city", "man city", "manchester united", "man united", "liverpool", "arsenal", "chelsea", "tottenham",
  "real madrid", "barcelona", "atletico", "atlético", "paris saint-germain", "psg", "bayern", "juventus", "inter", "milan",
  "napoli", "nigeria", "ghana", "senegal", "morocco", "egypt", "cameroon", "ivory coast", "côte d'ivoire",
  "south africa", "england", "france", "spain", "brazil", "argentina", "portugal", "germany", "netherlands", "italy",
];
export function isBigMatch(teamA: string, teamB: string): boolean {
  const t = `${teamA} | ${teamB}`.toLowerCase();
  return FAMOUS.some((f) => t.includes(f));
}
