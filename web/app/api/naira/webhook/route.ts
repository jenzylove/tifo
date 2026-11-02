import { NextResponse } from "next/server";
import { limit, tooMany } from "@/lib/ratelimit";
import { isCheckoutId, nairaConfig, releaseFor, verifyWebhook, why } from "@/lib/naira";
import { completeGuest, guestEnabled } from "@/lib/guest";
import { payoutEvent } from "@/lib/guestPayout";

export const maxDuration = 60;

// Bachs tells us a payment landed. We check the signature on the raw body, take only the checkout id from the event,
// and let releaseFor ask Bachs for the real state before any USDC moves. Bachs sends each event at least once and
// possibly out of order, which is fine: releasing the same checkout twice is a no-op.
// Answers: 200 handled or ignored, 401 bad signature (Bachs stops), 5xx anything that should be tried again (Bachs retries).
const WATCHED = new Set(["collection.succeeded", "checkout.completed"]);

export async function POST(req: Request) {
  const rl = limit(req, "naira-webhook", 120, 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const cfg = nairaConfig();
  if (!cfg || !cfg.webhookSecret) return NextResponse.json({ error: "not set up" }, { status: 503 });

  const raw = await req.text(); // the body exactly as sent: the signature covers these bytes
  if (!verifyWebhook(raw, req.headers.get("x-bachs-signature-v2"), cfg.webhookSecret, Math.floor(Date.now() / 1000))) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let event: { type?: unknown; data?: { checkout_id?: unknown } | null };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }
  // A guest's naira payout moved: the event names our reference, and the state is read back from Bachs.
  if (event?.type === "payout.paid" || event?.type === "payout.failed") {
    try {
      const handled = await payoutEvent((event.data as { reference?: unknown } | null)?.reference);
      return NextResponse.json(handled ? { state: "checked" } : { ignored: true });
    } catch (e) {
      console.error("naira payout webhook failed:", why(e));
      return NextResponse.json({ error: "try again" }, { status: 500 });
    }
  }
  const id = event?.data?.checkout_id;
  if (typeof event?.type !== "string" || !WATCHED.has(event.type) || !isCheckoutId(id)) return NextResponse.json({ ignored: true });

  try {
    const r = await releaseFor(id);
    // Not visible as paid yet, or the float cannot pay right now: ask Bachs to deliver this again later.
    if (r.state === "pending" || r.state === "float_short") return NextResponse.json({ retry: r.state }, { status: 503 });
    // Not a wallet top up: it may be a guest checkout (a different reference shape), which buys the order too.
    if (r.state === "not_paid" && guestEnabled()) {
      const g = await completeGuest(id);
      if (g.state === "pending" || g.state === "float_short") return NextResponse.json({ retry: g.state }, { status: 503 });
      return NextResponse.json({ state: g.state });
    }
    return NextResponse.json({ state: r.state });
  } catch (e) {
    console.error("naira webhook failed:", why(e));
    return NextResponse.json({ error: "try again" }, { status: 500 });
  }
}
