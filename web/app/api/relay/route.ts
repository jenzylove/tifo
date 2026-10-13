import { NextResponse } from "next/server";
import { getAddress, isAddress, isHex } from "viem";
import { z } from "zod";
import { maybeRebalance, payoutsTick, relayBuy } from "@/lib/agent";
import { listPromos } from "@/lib/promos";

export const maxDuration = 60;

const Body = z.object({
  promo: z.string().refine(isAddress),
  buyer: z.string().refine(isAddress),
  side: z.union([z.literal(0), z.literal(1)]),
  amount: z.string().regex(/^\d+$/),
  orderRef: z.string().refine((s) => isHex(s) && s.length === 66),
  minRateBps: z.number().int().min(0).max(10_000).default(0),
  deadline: z.string().regex(/^\d+$/),
  v: z.number().int(),
  r: z.string().refine((s) => isHex(s) && s.length === 66),
  s: z.string().refine((s) => isHex(s) && s.length === 66),
});

export async function POST(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const promo = (await listPromos()).find((x) => x.address.toLowerCase() === p.data.promo.toLowerCase());
  if (!promo) return NextResponse.json({ error: "unknown promo" }, { status: 404 });
  const amount = BigInt(p.data.amount);
  if (amount < 1_000_000n || amount > 2_000_000_000n) return NextResponse.json({ error: "amount out of range" }, { status: 400 });
  try {
    const hash = await relayBuy({
      promo: getAddress(p.data.promo),
      buyer: getAddress(p.data.buyer),
      side: p.data.side,
      amount,
      orderRef: p.data.orderRef as `0x${string}`,
      minRateBps: p.data.minRateBps,
      deadline: BigInt(p.data.deadline),
      v: p.data.v,
      r: p.data.r as `0x${string}`,
      s: p.data.s as `0x${string}`,
    });
    let rebalanced = null;
    await payoutsTick(promo.seller).catch((e) => console.error(e));
    try {
      rebalanced = await maybeRebalance(promo);
    } catch (e) {
      console.error("rebalance failed", e);
    }
    return NextResponse.json({ hash, rebalanced });
  } catch (e) {
    const msg = (e as Error).message;
    const known = /DuplicateOrder|OfferGone|OverCap|OneSidePerWallet|Closed|transfer amount exceeds|insufficient/i.exec(msg)?.[0];
    return NextResponse.json({ error: known ? friendly(known) : "The payment didn't go through. Nothing was charged." }, { status: 400 });
  }
}

function friendly(code: string) {
  if (/DuplicateOrder/i.test(code)) return "This order already went through. You were charged once.";
  if (/OfferGone|OverCap/i.test(code)) return "That offer just ran out. Refresh the page to see what is left.";
  if (/OneSide/i.test(code)) return "This wallet already backed the other team in this promo.";
  if (/Closed/i.test(code)) return "This promo closed at kickoff.";
  return "Not enough USDC in this wallet.";
}
