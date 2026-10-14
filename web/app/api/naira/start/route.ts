import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import { z } from "zod";
import { limit, tooMany } from "@/lib/ratelimit";
import { nairaConfig, nairaMissing, quote, startCheckout, usdToUnits, why } from "@/lib/naira";

export const maxDuration = 60;

// Pay in naira: a buyer with no USDC pays naira on a Bachs checkout, and the matching USDC is released to their Tifo wallet.
// GET tells the checkout whether to offer it at all, and with ?usd= what that many dollars cost in naira right now.
// POST opens the Bachs checkout. The price is worked out here from the dollar amount, never taken from the browser.
const no = { "cache-control": "no-store" };

export function GET(req: Request) {
  const cfg = nairaConfig();
  if (!cfg) return NextResponse.json({ enabled: false, missing: nairaMissing() }, { headers: no });
  const out: { enabled: true; rate: number; maxUsd: number; ngn?: string } = { enabled: true, rate: cfg.rate, maxUsd: cfg.maxUsd };
  const usd = new URL(req.url).searchParams.get("usd");
  const units = usd === null ? null : usdToUnits(Number(usd));
  if (units !== null) out.ngn = quote(units, cfg.rate);
  return NextResponse.json(out, { headers: no });
}

const Body = z.object({
  wallet: z.string().refine(isAddress),
  usd: z.number(),
  promo: z.string().refine(isAddress),
});

const ERRORS = {
  disabled: [503, "Naira payments are not set up yet."],
  bad_amount: [400, "That amount is not available in naira."],
  too_large: [400, "That is more than naira payments cover in one go. Add less here, or pay another way."],
  float_short: [503, "Naira payments are paused right now. Pay another way."],
  provider: [502, "Naira payments could not start. Nothing was charged. Try again in a minute."],
} as const;

export async function POST(req: Request) {
  const rl = limit(req, "naira-start", 10, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const cfg = nairaConfig();
  if (!cfg) return NextResponse.json({ error: ERRORS.disabled[1] }, { status: ERRORS.disabled[0] });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const units = p.data.usd >= 1 && p.data.usd <= cfg.maxUsd ? usdToUnits(p.data.usd) : null;
  if (units === null) return NextResponse.json({ error: ERRORS.bad_amount[1] }, { status: ERRORS.bad_amount[0] });
  try {
    // Bachs sends the buyer back to this site, so use the site's own address rather than whatever Host header arrived.
    const origin = process.env.NEXT_PUBLIC_SITE_URL?.trim() || new URL(req.url).origin;
    const r = await startCheckout({ wallet: getAddress(p.data.wallet), usdUnits: units, promo: getAddress(p.data.promo), origin });
    if (!r.ok) return NextResponse.json({ error: ERRORS[r.error][1] }, { status: ERRORS[r.error][0] });
    return NextResponse.json({ checkoutUrl: r.checkoutUrl, checkoutId: r.checkoutId, ngn: r.ngn, rate: r.rate }, { headers: no });
  } catch (e) {
    console.error("naira start failed:", why(e));
    return NextResponse.json({ error: ERRORS.provider[1] }, { status: ERRORS.provider[0] });
  }
}
