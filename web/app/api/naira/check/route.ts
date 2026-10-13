import { NextResponse } from "next/server";
import { z } from "zod";
import { limit, tooMany } from "@/lib/ratelimit";
import { isCheckoutId, nairaEnabled, releaseFor, why } from "@/lib/naira";

export const maxDuration = 60;

// The buyer's page asks "has my naira payment landed?" every few seconds, and once when Bachs sends the buyer back.
// This does not trust the page: it asks Bachs about the checkout and releases the USDC only if Bachs says it is paid.
// Asking twice (or at the same moment as the webhook) is safe, because the float contract pays each checkout once.
const Body = z.object({ checkoutId: z.string().refine(isCheckoutId) });

export async function POST(req: Request) {
  // A page polling every 5 seconds for 30 minutes makes 360 calls, so this allows more than the other routes.
  const rl = limit(req, "naira-check", 200, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  if (!nairaEnabled()) return NextResponse.json({ error: "Naira payments are not set up yet." }, { status: 503 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const r = await releaseFor(p.data.checkoutId);
    return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("naira check failed:", why(e));
    return NextResponse.json({ error: "Could not check the payment just now. Trying again." }, { status: 502 });
  }
}
