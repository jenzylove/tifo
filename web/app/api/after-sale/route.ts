import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { maybeRebalance, noteReferral, payoutsTick } from "@/lib/agent";
import { listPromos, promoStateFresh } from "@/lib/promos";
import { limit, tooMany } from "@/lib/ratelimit";

export const maxDuration = 60;

// How many orders of each drop the agent has already acted on. Anyone can call this route, and every action costs the
// agent gas, so it only works when the drop has an order it has not seen. A repeat call is a no-op. (Per instance: a
// cold instance may look once more, and rebalance and payout still check on chain that they have something to do.)
const handled = new Map<string, number>();

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
  const key = promo.address.toLowerCase();
  const st = await promoStateFresh(promo.address).catch(() => null);
  if (!st) return NextResponse.json({ error: "chain read failed, try again" }, { status: 503 });
  const before = handled.get(key) ?? 0;
  if (st.ordersCount === 0 || st.ordersCount <= before) return NextResponse.json({ changed: false, reason: "nothing new to process", paidOut: false });
  handled.set(key, st.ordersCount);
  if (handled.size > 2000) handled.delete(handled.keys().next().value!);
  let result: { changed: boolean; reason: string } = { changed: false, reason: "rebalance skipped" };
  try {
    result = await maybeRebalance(promo);
  } catch (e) {
    console.error(e);
  }
  let failed = result.reason === "rebalance skipped";
  const paid = await payoutsTick(promo.seller).catch((e) => ((failed = true), console.error(e), []));
  // The buyer came through a friend's link: if that friend now has enough referrals, the agent notes their free order.
  if (isAddress(body.referrer)) await noteReferral(promo, body.referrer).catch((e) => console.error(e));
  if (failed) handled.set(key, before); // something went wrong: let a later call try again
  return NextResponse.json({ ...result, paidOut: paid.length > 0 });
}
