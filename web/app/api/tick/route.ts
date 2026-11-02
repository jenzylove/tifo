import { NextResponse } from "next/server";
import { autopilotTick, tick } from "@/lib/agent";

export const maxDuration = 120;
const BUDGET_MS = 90_000;

// Called by the scheduler (a GitHub Actions run that calls every two minutes).
// Idempotent: it only acts on promos that are ready.
export async function GET(req: Request) {
  const secret = process.env.TICK_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret) return NextResponse.json({ error: "TICK_SECRET is not set on the server, so this endpoint is closed." }, { status: 500 });
  if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Each transaction waits for its receipt, so stop starting work well before maxDuration and let the next call continue.
  const startedAt = Date.now();
  let results: Awaited<ReturnType<typeof tick>>;
  try {
    results = await tick(BUDGET_MS);
  } catch (e) {
    console.error("tick failed", e);
    return NextResponse.json({ error: `tick failed: ${(e as Error).message.slice(0, 200)}` }, { status: 500, headers: { "cache-control": "no-store" } });
  }
  // After settling what is due, each seller's manager gets its turn to plan the next drop. The scheduler asks for
  // this once per run (about every five hours), not on every call, so the model is not asked every two minutes.
  if (new URL(req.url).searchParams.get("plan") === "1" && Date.now() - startedAt < BUDGET_MS)
    results.push(...(await autopilotTick().catch((e) => [{ promo: "0x0000000000000000000000000000000000000000" as const, action: `autopilot error: ${(e as Error).message.slice(0, 200)}` }])));
  return NextResponse.json({ at: new Date().toISOString(), results }, { headers: { "cache-control": "no-store" } });
}
