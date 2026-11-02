import { NextResponse } from "next/server";
import { z } from "zod";
import { limit, tooMany } from "@/lib/ratelimit";
import { explorerTx } from "@/lib/chain";
import { completeGuest, dropForStatus, guestEnabled, orderSecret, why } from "@/lib/guest";
import { isCheckoutId } from "@/lib/naira";

export const maxDuration = 60;

// The buyer's status page asks "is my order in?" every few seconds. This does not trust the page: completeGuest asks
// Bachs about the checkout and only moves money if Bachs says it is paid. Asking twice, or with the webhook, is safe.
// The answer never carries the phone number. Whoever holds the checkout id (only the buyer, from the Bachs return link)
// gets the order's secret once it is in, so the drop page can open a digital product or take a delivery address.
const Body = z.object({
  checkoutId: z.string().refine(isCheckoutId),
  accept: z.number().int().min(0).max(10_000).optional(), // the offer the buyer took after the shown one moved
});

export async function POST(req: Request) {
  const rl = limit(req, "naira-guest-check", 200, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  if (!guestEnabled()) return NextResponse.json({ error: "Naira checkout is not on yet." }, { status: 503 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const r = await completeGuest(p.data.checkoutId, p.data.accept);
    const rec = "record" in r ? r.record : undefined;
    const out: Record<string, unknown> = { state: r.state };
    if (rec) {
      out.order = { promo: rec.promo, side: rec.side, amount: rec.amount, rateBps: rec.rateBps, guest: rec.guest };
      out.drop = await dropForStatus(rec.promo).catch(() => null);
    }
    if (r.state === "done") {
      out.tx = r.tx;
      out.txUrl = r.tx ? explorerTx(r.tx) : null;
      out.secret = orderSecret(p.data.checkoutId);
    }
    if (r.state === "refund_due") out.reason = r.reason;
    return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("guest check failed:", why(e));
    return NextResponse.json({ error: "Could not check the payment just now. Trying again." }, { status: 502 });
  }
}
