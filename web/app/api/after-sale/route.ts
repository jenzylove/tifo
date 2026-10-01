import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { maybeRebalance } from "@/lib/agent";
import { listPromos } from "@/lib/promos";

export const maxDuration = 60;

// Called after a Circle-wallet purchase (the fan's smart account paid directly, so the relayer
// never saw it). The agent re-reads the book from chain and only acts if the offers should move.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || !isAddress(body.promo)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const promo = (await listPromos()).find((p) => p.address.toLowerCase() === String(body.promo).toLowerCase());
  if (!promo) return NextResponse.json({ error: "unknown promo" }, { status: 404 });
  try {
    return NextResponse.json(await maybeRebalance(promo));
  } catch (e) {
    console.error(e);
    return NextResponse.json({ changed: false, reason: "rebalance skipped" });
  }
}
