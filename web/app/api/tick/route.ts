import { NextResponse } from "next/server";
import { autopilotTick, tick } from "@/lib/agent";

export const maxDuration = 120;

// Called by the scheduler (GitHub Actions every 10 minutes) and by page loads after full time.
// Idempotent: it only acts on promos that are ready.
export async function GET(req: Request) {
  const secret = process.env.TICK_SECRET;
  const auth = req.headers.get("authorization");
  if (secret && auth !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const results = await tick();
  // After settling what is due, each seller's manager gets its turn to plan the next drop.
  results.push(...(await autopilotTick().catch((e) => [{ promo: "0x0000000000000000000000000000000000000000" as const, action: `autopilot error: ${(e as Error).message.slice(0, 200)}` }])));
  return NextResponse.json({ at: new Date().toISOString(), results }, { headers: { "cache-control": "no-store" } });
}
