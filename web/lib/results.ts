// Final results from three independent sources. The agent proposes a result on chain only when
// ESPN agrees with at least one of TheSportsDB or Polymarket's resolved market. Otherwise it waits or escalates.
import { keccak256, toBytes } from "viem";
import type { Match } from "./matches";

export type Verdict = "A" | "B" | "DRAW" | "VOID";

export interface SourceResult {
  source: "espn" | "thesportsdb" | "polymarket";
  status: "final" | "pending" | "postponed" | "not_found" | "error";
  verdict?: Verdict;
  score?: string;
  raw?: string; // compact payload, hashed into the on-chain evidence
}

export interface Consensus {
  verdict: Verdict | null;
  reason: string;
  sources: SourceResult[];
  evidence: `0x${string}`;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(fc|afc|cf|sc|fk|sk|ac|ssc|cd|ca|club|de|the|and|lfc|wfc|women|hove)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Same team when every word of the shorter name appears in the longer one
 * ("AFC Bournemouth" ~ "Bournemouth", but "Manchester City" is not "Manchester United"). */
export function sameTeam(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  return short.every((w) => long.has(w));
}

/** The official name, or any everyday name for it, is the same team as a source's name. */
function clubMatches(official: string, theirs: string): boolean {
  return sameTeam(official, theirs) || everydayNames(official).some((n) => sameTeam(n, theirs));
}

function verdictFrom(home: number, away: number): Verdict {
  return home > away ? "A" : away > home ? "B" : "DRAW";
}

async function espn(m: Match): Promise<SourceResult> {
  try {
    const d = new Date(m.kickoff);
    const days = [-1, 0, 1].map((k) => new Date(d.getTime() + k * 86_400_000).toISOString().slice(0, 10).replace(/-/g, ""));
    for (const day of days) {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${m.league.espn}/scoreboard?dates=${day}`, { cache: "no-store" });
      if (!r.ok) continue;
      const j = await r.json();
      for (const ev of j.events ?? []) {
        const c = ev.competitions?.[0];
        const home = c?.competitors?.find((x: { homeAway: string }) => x.homeAway === "home");
        const away = c?.competitors?.find((x: { homeAway: string }) => x.homeAway === "away");
        if (!home || !away || !clubMatches(m.teamA, home.team.displayName) || !clubMatches(m.teamB, away.team.displayName)) continue;
        const state = ev.status?.type?.name as string;
        const raw = `${home.team.displayName} ${home.score}-${away.score} ${away.team.displayName} ${state}`;
        if (state === "STATUS_POSTPONED" || state === "STATUS_CANCELED" || state === "STATUS_ABANDONED")
          return { source: "espn", status: "postponed", verdict: "VOID", raw };
        if (state !== "STATUS_FULL_TIME" && state !== "STATUS_FINAL") return { source: "espn", status: "pending", raw };
        const verdict = verdictFrom(Number(home.score), Number(away.score));
        return { source: "espn", status: "final", verdict, score: `${home.score}-${away.score}`, raw };
      }
    }
    return { source: "espn", status: "not_found" };
  } catch {
    return { source: "espn", status: "error" };
  }
}

// TheSportsDB files clubs under their everyday English names, and its free search returns one row for an exact
// "Home vs Away" title. So the official name is reduced to the everyday one before searching.
const EVERYDAY: [RegExp, string][] = [
  [/internazionale/i, "Inter Milan"],
  [/paris saint.?germain/i, "Paris SG"],
  [/bayern/i, "Bayern Munich"],
  [/atl[eé]tico( de)? madrid/i, "Atletico Madrid"],
  [/athletic club/i, "Athletic Bilbao"],
  [/m[oö]nchengladbach/i, "Monchengladbach"],
  [/leverkusen/i, "Bayer Leverkusen"],
  [/tottenham/i, "Tottenham"],
  [/wolverhampton/i, "Wolves"],
  [/brighton/i, "Brighton"],
  [/olympique de marseille/i, "Marseille"],
  [/olympique lyonnais/i, "Lyon"],
  [/rayo vallecano/i, "Rayo Vallecano"],
  [/real sociedad/i, "Real Sociedad"],
  [/real betis/i, "Real Betis"],
  [/celta/i, "Celta Vigo"],
  [/benfica/i, "Benfica"],
  [/sporting (cp|clube de portugal)/i, "Sporting CP"],
  [/^fc porto$|futebol clube do porto/i, "Porto"],
  [/olymp[ia]+[kc][oó]s/i, "Olympiacos"],
  [/sturm graz/i, "Sturm Graz"],
  [/be[sş]ikta[sş]/i, "Besiktas"],
  [/fenerbah[cç]e/i, "Fenerbahce"],
  [/galatasaray/i, "Galatasaray"],
  [/dinamo zagreb/i, "Dinamo Zagreb"],
  [/anderlecht/i, "Anderlecht"],
  [/ferencv[aá]ros/i, "Ferencvaros"],
  [/viktoria plze[nň]/i, "Viktoria Plzen"],
  [/levski sofia/i, "Levski Sofia"],
  [/jagiellonia/i, "Jagiellonia"],
];
const CLUB_WORDS = /\b(fc|afc|cf|osc|ac|sc|ssc|as|rc|rcd|ud|cd|ca|sv|vfl|vfb|tsg|calcio|club|de|f[uú]tbol|jk|sk|fk|pfk|nk|gnk|rsc|sfp|bk|if|ik|\d+\.?)\b/gi;
// Words many clubs share; never used alone to name a club.
const GENERIC = /^(united|city|town|athletic|rovers|wanderers|albion|county|real|sporting|olympique|dynamo|dinamo|racing|union|hotspur|villa|forest|palace|rangers|celtic|juniors|athletico|atletico)$/i;
const plain = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i");

/** The names to try for one club, most likely first. */
export function everydayNames(name: string): string[] {
  const out: string[] = [];
  const alias = EVERYDAY.find(([re]) => re.test(name));
  if (alias) out.push(alias[1]);
  const stripped = name.replace(CLUB_WORDS, " ").replace(/\s+/g, " ").trim();
  if (stripped) out.push(stripped, plain(stripped));
  out.push(name.replace(/\b(FC|AFC|CF)\b/g, "").replace(/\s+/g, " ").trim());
  // Long official names ("Sport Lisboa e Benfica"): the club is usually known by its last word.
  const words = stripped.split(" ");
  const last = plain(words[words.length - 1] ?? "");
  if (words.length >= 3 && last.length >= 5 && !GENERIC.test(last)) out.push(last);
  return [...new Set(out.filter(Boolean))];
}

/** Looser than sameTeam: a word may be a short form of the other name's word ("Inter" ~ "Internazionale"). */
function likelySameTeam(a: string, b: string): boolean {
  if (sameTeam(a, b)) return true;
  const x = norm(a), y = norm(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.every((w) => long.some((v) => (w.length >= 4 && v.startsWith(w)) || (v.length >= 4 && w.startsWith(v))));
}

async function theSportsDb(m: Match): Promise<SourceResult> {
  try {
    const day = m.kickoff.slice(0, 10);
    const homes = everydayNames(m.teamA), aways = everydayNames(m.teamB);
    // Most likely pair first, then the fallbacks. Six lookups at most.
    const pairs: [string, string][] = [];
    for (let k = 0; k < Math.max(homes.length, aways.length); k++) pairs.push([homes[Math.min(k, homes.length - 1)], aways[Math.min(k, aways.length - 1)]]);
    for (const h of homes) for (const a of aways) if (!pairs.some(([x, y]) => x === h && y === a)) pairs.push([h, a]);
    let failed = false;
    for (const [h, a] of pairs.slice(0, 6)) {
      const q = `${h}_vs_${a}`.replace(/\s+/g, "_");
      const r = await fetch(`https://www.thesportsdb.com/api/v1/json/123/searchevents.php?e=${encodeURIComponent(q)}`, { cache: "no-store" });
      if (!r.ok) {
        failed = true;
        continue;
      }
      const j = await r.json();
      const ev = (j.event ?? []).find(
        (e: { dateEvent: string; strHomeTeam: string; strAwayTeam: string }) =>
          Math.abs(Date.parse(e.dateEvent) - Date.parse(day)) <= 86_400_000 &&
          ((likelySameTeam(h, e.strHomeTeam) && likelySameTeam(a, e.strAwayTeam)) || (likelySameTeam(h, e.strAwayTeam) && likelySameTeam(a, e.strHomeTeam))),
      );
      if (!ev) continue;
      const raw = `${ev.strEvent} ${ev.intHomeScore}-${ev.intAwayScore} ${ev.strStatus}`;
      if (/postponed|cancel|abandon/i.test(ev.strStatus ?? "")) return { source: "thesportsdb", status: "postponed", verdict: "VOID", raw };
      if (!/^(FT|AET|PEN|Match Finished)$/i.test(ev.strStatus ?? "") || ev.intHomeScore == null) return { source: "thesportsdb", status: "pending", raw };
      // TheSportsDB names the home team first; check orientation against our home team.
      const flipped = likelySameTeam(h, ev.strAwayTeam) && !likelySameTeam(h, ev.strHomeTeam);
      const [hs, as] = [Number(ev.intHomeScore), Number(ev.intAwayScore)];
      const verdict = flipped ? verdictFrom(as, hs) : verdictFrom(hs, as);
      return { source: "thesportsdb", status: "final", verdict, score: `${hs}-${as}`, raw };
    }
    return { source: "thesportsdb", status: failed ? "error" : "not_found" };
  } catch {
    return { source: "thesportsdb", status: "error" };
  }
}

async function polymarket(m: Match): Promise<SourceResult> {
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(m.slug)}`, { cache: "no-store" });
    const [e] = await r.json();
    if (!e) return { source: "polymarket", status: "not_found" };
    const win = (e.markets ?? []).find(
      (mk: { umaResolutionStatus?: string; outcomePrices?: string }) =>
        mk.umaResolutionStatus === "resolved" && JSON.parse(mk.outcomePrices ?? "[]")[0] === "1",
    );
    if (!win) return { source: "polymarket", status: "pending" };
    const t: string = win.groupItemTitle ?? "";
    const verdict: Verdict = t.startsWith("Draw") ? "DRAW" : t === m.teamA ? "A" : t === m.teamB ? "B" : "VOID";
    return { source: "polymarket", status: "final", verdict, raw: `resolved: ${t}` };
  } catch {
    return { source: "polymarket", status: "error" };
  }
}

export async function checkResult(m: Match): Promise<Consensus> {
  const sources = await Promise.all([espn(m), theSportsDb(m), polymarket(m)]);
  const evidence = keccak256(toBytes(JSON.stringify(sources.map((s) => [s.source, s.status, s.verdict ?? null, s.raw ?? null]))));
  const postponed = sources.filter((s) => s.status === "postponed");
  if (postponed.length >= 2) return { verdict: "VOID", reason: "Postponed or abandoned, confirmed by two sources", sources, evidence };
  const finals = sources.filter((s) => s.status === "final" && s.verdict && s.verdict !== "VOID");
  const verdicts = new Set(finals.map((s) => s.verdict));
  const list = sources.map((s) => `${s.source}=${s.verdict ?? s.status}`).join(", ");
  if (verdicts.size > 1) return { verdict: null, reason: `Sources disagree: ${list}`, sources, evidence };
  if (finals.length < 2) return { verdict: null, reason: `Waiting for two sources to agree (${list})`, sources, evidence };
  const v = finals[0].verdict as Verdict;
  const score = finals.find((s) => s.score)?.score;
  return { verdict: v, reason: `${finals.length} independent sources agree${score ? ` (${score})` : ""}: ${finals.map((f) => f.source).join(", ")}`, sources, evidence };
}
