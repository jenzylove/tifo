import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { runSellerChat } from "@/lib/sellerAgent";
import { shopOf } from "@/lib/shops";

export const maxDuration = 120;

const Body = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) })).min(1).max(40),
  seller: z.string().optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const seller = parsed.data.seller;
    const shop = seller && isAddress(seller) ? await shopOf(seller) : null;
    const out = await runSellerChat(parsed.data.messages, shop);
    return NextResponse.json(out);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "The agent couldn't answer just now. Try again in a moment." }, { status: 502 });
  }
}
