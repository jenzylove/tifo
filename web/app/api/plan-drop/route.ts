import { NextResponse } from "next/server";
import { z } from "zod";
import { planDrop } from "@/lib/dropPlan";
import { limit, tooMany } from "@/lib/ratelimit";

export const maxDuration = 60;

const Body = z.object({
  product: z.string().trim().min(1).max(80),
  priceUsd: z.number().min(1).max(10_000),
  units: z.number().int().min(1).max(500),
  kind: z.enum(["digital", "physical", "booking"]),
  profitUsd: z.number().min(0).max(10_000).nullable().optional(),
  shop: z.string().trim().max(60).nullable().optional(),
});

// The agent's plan for a new drop. Read only: nothing is sent from here.
export async function POST(req: Request) {
  const rl = limit(req, "plan-drop", 15, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Add the product, its price and how many you have." }, { status: 400 });
  try {
    return NextResponse.json(await planDrop(p.data));
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: (e as Error).message.startsWith("No big match") ? (e as Error).message : "Your agent couldn't plan just now. Try again in a moment." }, { status: 502 });
  }
}
