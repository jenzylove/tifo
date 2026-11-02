import { NextResponse } from "next/server";
import { z } from "zod";
import { limit, tooMany } from "@/lib/ratelimit";
import { guestEnabled, why } from "@/lib/guest";
import { collectMoneyBack, listBanks, payoutStatus, setAccount } from "@/lib/guestPayout";
import { isCheckoutId } from "@/lib/naira";

export const maxDuration = 60;

// A guest buyer collects their money back to a Nigerian bank. Holding the checkout id (from the Bachs return link) is
// the proof, as on the status page. GET lists the banks. POST asks where things stand, sets the account (and gets the
// name the bank resolved, to confirm), or, once confirmed, collects. The answer never carries a phone or a full account number.
const no = { "cache-control": "no-store" };

export async function GET(req: Request) {
  const rl = limit(req, "naira-guest-banks", 60, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  try {
    return NextResponse.json({ banks: guestEnabled() ? await listBanks() : [] }, { headers: { "cache-control": "public, max-age=3600" } });
  } catch (e) {
    console.error("guest banks failed:", why(e));
    return NextResponse.json({ banks: [] }, { headers: no });
  }
}

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), checkoutId: z.string().refine(isCheckoutId) }),
  z.object({ action: z.literal("account"), checkoutId: z.string().refine(isCheckoutId), bankCode: z.string().regex(/^[A-Za-z0-9]{2,12}$/), accountNumber: z.string().regex(/^\d{10}$/) }),
  z.object({ action: z.literal("collect"), checkoutId: z.string().refine(isCheckoutId) }),
]);

const STATUS: Record<string, number> = { disabled: 200, not_found: 404, not_allowed: 409, bad_account: 400, busy: 409, provider: 502 };

export async function POST(req: Request) {
  const rl = limit(req, "naira-guest-payout", 120, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  if (!guestEnabled()) return NextResponse.json({ error: "Naira checkout is not on yet." }, { status: 503 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Check the bank and the 10 digit account number." }, { status: 400 });
  try {
    const d = p.data;
    const r = d.action === "status" ? await payoutStatus(d.checkoutId) : d.action === "account" ? await setAccount(d.checkoutId, d.bankCode, d.accountNumber) : await collectMoneyBack(d.checkoutId);
    if ("error" in r) {
      // Not open yet is not an error for the buyer: their money is held, and the page says so.
      if (r.error === "disabled") return NextResponse.json({ can: "held_closed", message: r.message }, { headers: no });
      return NextResponse.json({ error: r.message, code: r.error }, { status: STATUS[r.error] ?? 400, headers: no });
    }
    return NextResponse.json(r, { headers: no });
  } catch (e) {
    console.error("guest payout failed:", why(e));
    return NextResponse.json({ error: "Could not reach the bank just now. Your money is safe. Try again in a minute." }, { status: 502 });
  }
}
