import { NextResponse } from "next/server";
import { z } from "zod";
import { deliveryEnabled, seal } from "@/lib/delivery";
import { limit, tooMany } from "@/lib/ratelimit";

const Body = z.object({ text: z.string().trim().min(1).max(600) });

// Seals what a buyer receives after paying (a download link, an access code, a note).
export async function POST(req: Request) {
  const rl = limit(req, "seal", 30, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  if (!deliveryEnabled()) return NextResponse.json({ error: "Instant delivery is not set up on this deployment." }, { status: 503 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Add a link or a short note, up to 600 characters." }, { status: 400 });
  return NextResponse.json({ sealed: seal(p.data.text) });
}
