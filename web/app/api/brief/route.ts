import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { managerBrief } from "@/lib/brief";
import { limit, tooMany } from "@/lib/ratelimit";

export const maxDuration = 120;

export async function GET(req: Request) {
  const u = new URL(req.url);
  const fresh = u.searchParams.get("fresh") === "1";
  const rl = fresh ? limit(req, "brief-fresh", 4, 10 * 60_000) : limit(req, "brief", 30, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const a = u.searchParams.get("address") ?? "";
  if (!isAddress(a)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  try {
    return NextResponse.json(await managerBrief(a, fresh));
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Your manager couldn't put the briefing together just now." }, { status: 502 });
  }
}
