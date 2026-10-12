import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { managerData } from "@/lib/manager";
import { shortTeam } from "@/lib/matches";
import { runSellerChat, type SellerContext } from "@/lib/sellerAgent";
import { limit, tooMany } from "@/lib/ratelimit";

export const maxDuration = 120;

const Body = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) })).min(1).max(40),
  seller: z.string().optional(),
});

export async function POST(req: Request) {
  const rl = limit(req, "chat", 12, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const seller = parsed.data.seller;
    const out = await runSellerChat(parsed.data.messages, seller && isAddress(seller) ? await context(seller) : null);
    return NextResponse.json(out);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "The agent couldn't answer just now. Try again in a moment." }, { status: 502 });
  }
}

const $ = (u: string) => `$${(Number(u) / 1e6).toFixed(2)}`;

/** What the agent already knows about this seller, read from their drops on chain. */
async function context(seller: `0x${string}`): Promise<SellerContext | null> {
  const d = await managerData(seller).catch(() => null);
  if (!d?.name) return null;
  return {
    name: d.name,
    pastDrops: d.drops.slice(0, 6).map((x) => ({
      match: `${shortTeam(x.meta.teamA)} v ${shortTeam(x.meta.teamB)}`,
      product: x.meta.product,
      priceUsd: x.meta.priceUsd,
      ordersBySide: x.bySide,
      sales: $(x.sales),
      refunded: $(x.refunded),
      outcome: x.phase === "settled" ? x.outcome : x.phase,
    })),
  };
}
