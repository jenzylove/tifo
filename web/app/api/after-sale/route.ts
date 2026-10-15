import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { maybeRebalance, noteReferral, payoutsTick } from "@/lib/agent";
import { listPromos } from "@/lib/promos";
import { limit, tooMany } from "@/lib/ratelimit";

export const maxDuration = 60;

// Called after a Circle-wallet purchase (the fan's smart account paid directly, so the relayer
// never saw it). The agent re-reads the book from chain, moves the offers only if they should move,
// and sends the seller's share of the sale on to their payout wallet.
export async function POST(req: Request) {
  const rl = limit(req, "after-sale", 30, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const body = await req.json().catch(() => null);
  if (!body || !isAddress(body.promo)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const promo = (await listPromos()).find((p) => p.address.toLowerCase() === String(body.promo).toLowerCase());
  if (!promo) return NextResponse.json({ error: "unknown promo" }, { status: 404 });
  let result: { changed: boolean; reason: string } = { changed: false, reason: "rebalance skipped" };
  try {
    result = await maybeRebalance(promo);
  } catch (e) {
    console.error(e);
  }
  const paid = await payoutsTick(promo.seller).catch((e) => (console.error(e), []));
  // The buyer came through a friend's link: if that friend now has enough referrals, the agent notes their free order.
  if (isAddress(body.referrer)) await noteReferral(promo, body.referrer).catch((e) => console.error(e));
  return NextResponse.json({ ...result, paidOut: paid.length > 0 });
}
