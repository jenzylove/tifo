import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { publicClient } from "@/lib/chain";
import { tifoPromoAbi } from "@/lib/abi";
import { blobStore, guestEnabled, sweepGuest, why } from "@/lib/guest";
import { isCheckoutId, usdcBalance } from "@/lib/naira";

export const maxDuration = 60;

// For the agent (scheduler secret only). Money back for a guest buyer lands at their Tifo number's address: the drop
// pays it there itself. GET ?promo= lists what each guest order holds. POST { promo, checkoutId } collects a refund the
// drop kept for that buyer (claim() from their key), so it sits with the rest of their money. Nothing is sent anywhere
// else and no phone number is ever returned here.
const authed = (req: Request) => {
  const secret = process.env.TICK_SECRET;
  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
};
const no = { "cache-control": "no-store" };

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!guestEnabled()) return NextResponse.json({ orders: [] }, { headers: no });
  const promo = new URL(req.url).searchParams.get("promo");
  if (!promo || !isAddress(promo)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const records = await blobStore.list(getAddress(promo));
    const orders = await Promise.all(
      records.map(async (r) => {
        const [owed, held] = await Promise.all([
          publicClient.readContract({ address: r.promo, abi: tifoPromoAbi, functionName: "owed", args: [r.guest] }) as Promise<bigint>,
          usdcBalance(r.guest),
        ]);
        return { checkoutId: r.checkoutId, guest: r.guest, side: r.side, amount: r.amount, status: r.status, reason: r.reason ?? null, tx: r.tx ?? null, owed: owed.toString(), held: held.toString(), payout: r.payout?.state ?? null, payoutId: r.payout?.payoutId ?? null };
      }),
    );
    return NextResponse.json({ orders }, { headers: no });
  } catch (e) {
    console.error("guest list failed:", why(e));
    return NextResponse.json({ error: "could not read" }, { status: 502 });
  }
}

const Body = z.object({ promo: z.string().refine(isAddress), checkoutId: z.string().refine(isCheckoutId) });

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!guestEnabled()) return NextResponse.json({ error: "not set up" }, { status: 503 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const r = await sweepGuest(getAddress(p.data.promo), p.data.checkoutId);
    if (!r) return NextResponse.json({ error: "no such order" }, { status: 404 });
    return NextResponse.json({ ...r, owed: r.owed.toString(), held: r.held.toString() }, { headers: no });
  } catch (e) {
    console.error("guest claim failed:", why(e));
    return NextResponse.json({ error: "try again" }, { status: 502 });
  }
}
