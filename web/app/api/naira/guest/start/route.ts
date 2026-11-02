import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { limit, tooMany } from "@/lib/ratelimit";
import { guestEnabled, guestQuote, startGuest, why } from "@/lib/guest";

export const maxDuration = 60;

// Pay in naira without a wallet. GET says whether it is on, and with ?promo=&qty= what that order costs in naira now.
// POST takes the buyer's phone number and club, and opens the Bachs checkout. The price is worked out here from the drop.
const no = { "cache-control": "no-store" };

export async function GET(req: Request) {
  if (!guestEnabled()) return NextResponse.json({ enabled: false }, { headers: no });
  const q = new URL(req.url).searchParams;
  const promo = q.get("promo");
  if (!promo) return NextResponse.json({ enabled: true }, { headers: no });
  const qty = Number(q.get("qty") ?? "1");
  if (!isAddress(promo) || !Number.isInteger(qty) || qty < 1 || qty > 20) return NextResponse.json({ enabled: true }, { headers: no });
  try {
    const r = await guestQuote(getAddress(promo), qty);
    if (!r) return NextResponse.json({ enabled: false }, { headers: no });
    return NextResponse.json({ enabled: true, ...r }, { headers: no });
  } catch (e) {
    console.error("guest quote failed:", why(e));
    return NextResponse.json({ enabled: true, busy: true }, { headers: no });
  }
}

const Body = z.object({
  phone: z.string().max(40),
  promo: z.string().refine(isAddress),
  side: z.union([z.literal(0), z.literal(1)]),
  qty: z.number().int().min(1).max(20),
  referrer: z.string().refine(isAddress).optional(),
});

const GUEST_ERRORS = {
  disabled: [503, "Naira checkout is not on yet. Pay another way."],
  bad_phone: [400, "Check your WhatsApp number. Example: 0803 123 4567."],
  bad_request: [400, "Something on this order is not right. Refresh the page and try again."],
  not_found: [404, "This drop could not be found."],
  not_supported: [400, "This drop needs a time picked, so pay with a Tifo wallet."],
  too_large: [400, "That is more than naira checkout covers in one go. Pick fewer items."],
  busy: [503, "Naira checkout is busy. Try again in a few minutes."],
  closed: [409, "This sale has ended."],
  other_side: [409, "This number already picked the other club on this drop. Pick the same club to order more."],
  provider: [502, "Naira checkout could not start. Nothing was charged. Try again in a minute."],
} as const;

export async function POST(req: Request) {
  const rl = limit(req, "naira-guest-start", 10, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  if (!guestEnabled()) return NextResponse.json({ error: GUEST_ERRORS.disabled[1] }, { status: GUEST_ERRORS.disabled[0] });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    // Bachs sends the buyer back to this site, so use the site's own address rather than whatever Host header arrived.
    const origin = process.env.NEXT_PUBLIC_SITE_URL?.trim() || new URL(req.url).origin;
    const r = await startGuest({
      phone: p.data.phone,
      promo: getAddress(p.data.promo),
      side: p.data.side,
      qty: p.data.qty,
      referrer: p.data.referrer ? getAddress(p.data.referrer) : undefined,
      origin,
    });
    if (!r.ok) return NextResponse.json({ error: GUEST_ERRORS[r.error][1], code: r.error }, { status: GUEST_ERRORS[r.error][0] });
    return NextResponse.json({ checkoutUrl: r.checkoutUrl, checkoutId: r.checkoutId, ngn: r.ngn, rateBps: r.rateBps, usd: r.usd }, { headers: no });
  } catch (e) {
    console.error("guest start failed:", why(e));
    return NextResponse.json({ error: GUEST_ERRORS.provider[1] }, { status: GUEST_ERRORS.provider[0] });
  }
}
