// What the three result sources say right now for every match that has a drop on the live site.
// Usage: npx tsx scripts/result-check.mts
import { matchBySlug } from "../web/lib/matches.ts";
import { checkResult } from "../web/lib/results.ts";

const url = process.env.TIFO_URL ?? "https://tifo.vercel.app";
const promos = (await (await fetch(`${url}/api/promos`)).json()) as { meta: { slug: string } }[];
for (const slug of [...new Set(promos.map((p) => p.meta.slug))]) {
  const m = await matchBySlug(slug);
  if (!m) {
    console.log(`${slug}: match not found`);
    continue;
  }
  const c = await checkResult(m);
  console.log(`${slug} | kickoff ${m.kickoff} | verdict ${c.verdict ?? "none yet"} | ${c.reason}`);
}
