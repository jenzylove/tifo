import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { planFor } from "@/lib/autopilot";
import { limit, tooMany } from "@/lib/ratelimit";

export const maxDuration = 120;

// What the seller's manager would do next, and why. Read only: nothing is sent from here.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const fresh = u.searchParams.get("fresh") === "1";
  const rl = fresh ? limit(req, "plan-fresh", 4, 10 * 60_000) : limit(req, "plan", 30, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const a = u.searchParams.get("address") ?? "";
  if (!isAddress(a)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  try {
    const { terms: _terms, meta: _meta, ...plan } = await planFor(a, fresh);
    return NextResponse.json(plan);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Your manager couldn't plan just now. Try again in a moment." }, { status: 502 });
  }
}
