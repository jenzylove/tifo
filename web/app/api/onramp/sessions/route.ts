import { NextResponse } from "next/server";
import { createOnrampServerKit, createSessionRouteHandler } from "@circle-fin/onramp-kit/server";
import { limit, tooMany } from "@/lib/ratelimit";

// Circle's Arc Onramp: a buyer with no crypto pays by card, Apple Pay or Google Pay and USDC lands in their Tifo
// wallet on Arc. This route trades our Circle API key (server only) for a short session the browser can use.
const key = process.env.CIRCLE_API_KEY;
const host = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://tifo.vercel.app").hostname;
const handler = key ? createSessionRouteHandler(createOnrampServerKit({ apiKey: key, referrerDomain: host })) : null;

/** Lets the checkout know whether to offer "Pay with card" at all. */
export function GET() {
  return NextResponse.json({ enabled: !!handler }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const rl = limit(req, "onramp", 10, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  if (!handler) return NextResponse.json({ error: "Card payments are not set up yet." }, { status: 503 });
  return handler(req);
}
