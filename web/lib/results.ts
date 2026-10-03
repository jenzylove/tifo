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
        if (!home || !away || !sameTeam(m.teamA, home.team.displayName) || !sameTeam(m.teamB, away.team.displayName)) continue;
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

async function theSportsDb(m: Match): Promise<SourceResult> {
  try {
    const q = `${m.teamA.replace(/\b(FC|AFC|CF)\b/g, "").trim()}_vs_${m.teamB.replace(/\b(FC|AFC|CF)\b/g, "").trim()}`.replace(/\s+/g, "_");
    const r = await fetch(`https://www.thesportsdb.com/api/v1/json/123/searchevents.php?e=${encodeURIComponent(q)}`, { cache: "no-store" });
    if (!r.ok) return { source: "thesportsdb", status: "error" };
    const j = await r.json();
    const day = m.kickoff.slice(0, 10);
    const ev = (j.event ?? []).find((e: { dateEvent: string }) => Math.abs(Date.parse(e.dateEvent) - Date.parse(day)) <= 86_400_000);
    if (!ev) return { source: "thesportsdb", status: "not_found" };
    const raw = `${ev.strEvent} ${ev.intHomeScore}-${ev.intAwayScore} ${ev.strStatus}`;
    if (/postponed|cancel|abandon/i.test(ev.strStatus ?? "")) return { source: "thesportsdb", status: "postponed", verdict: "VOID", raw };
    if (!/^(FT|AET|PEN|Match Finished)$/i.test(ev.strStatus ?? "") || ev.intHomeScore == null) return { source: "thesportsdb", status: "pending", raw };
    // TheSportsDB names the home team first in strEvent; check orientation.
    const flipped = sameTeam(m.teamA, ev.strAwayTeam) && sameTeam(m.teamB, ev.strHomeTeam);
    const [h, a] = [Number(ev.intHomeScore), Number(ev.intAwayScore)];
    const verdict = flipped ? verdictFrom(a, h) : verdictFrom(h, a);
    return { source: "thesportsdb", status: "final", verdict, score: `${h}-${a}`, raw };
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
