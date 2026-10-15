import { NextResponse } from "next/server";
import { createOnrampServerKit, createSessionRouteHandler } from "@circle-fin/onramp-kit/server";
import { limit, tooMany } from "@/lib/ratelimit";
import { ONRAMP_SANDBOX, ONRAMP_WIDGET } from "@/lib/onramp";

// Circle's Arc Onramp: a buyer with no crypto pays by card, Apple Pay, Google Pay or bank transfer and USDC lands in
// their Tifo wallet on Arc. This route trades our Circle API key (server only) for a short session the browser can use.
// NEXT_PUBLIC_ONRAMP_SANDBOX=1 points both sides at Circle's sandbox (test card, any OTP, any face photo passes KYC).
const key = process.env.CIRCLE_API_KEY?.trim();
const host = new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://tifo.vercel.app").hostname;
const handler = key
  ? createSessionRouteHandler(
      createOnrampServerKit({
        apiKey: key,
        referrerDomain: host,
        widgetBaseUrl: ONRAMP_WIDGET,
        ...(ONRAMP_SANDBOX ? { baseUrl: "https://api-test.circle.com" } : {}),
      }),
    )
  : null;

/** Lets the checkout know whether to offer card and bank payments at all, and against which environment. */
export function GET() {
  return NextResponse.json({ enabled: !!handler, sandbox: ONRAMP_SANDBOX }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const rl = limit(req, "onramp", 10, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  if (!handler) return NextResponse.json({ error: "Card payments are not set up yet." }, { status: 503 });
  return handler(req);
}
