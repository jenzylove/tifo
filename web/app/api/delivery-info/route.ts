import { NextResponse } from "next/server";
import { isAddress, isHex, type Hex } from "viem";
import { z } from "zod";
import { infoEnabled, paidBuyer, saveInfo } from "@/lib/deliveryInfo";
import { listPromos } from "@/lib/promos";
import { limit, tooMany } from "@/lib/ratelimit";
import { dropOwner } from "@/lib/tifoAccount";

const Body = z.object({
  promo: z.string().refine(isAddress),
  hash: z.string().refine((s) => isHex(s) && s.length === 66),
  secret: z.string().refine((s) => isHex(s) && s.length === 66),
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(6).max(30),
  address: z.string().trim().min(6).max(300),
  note: z.string().trim().max(300).optional(),
});

// A buyer of a physical product says where it should go. Only a paid order of this drop can do it, and what it writes
// is sealed for the seller.
export async function POST(req: Request) {
  const rl = limit(req, "delivery-info", 20, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  if (!infoEnabled()) return NextResponse.json({ error: "Delivery details are not set up on this site. Message the seller instead." }, { status: 503 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Add your name, a phone number and the full address." }, { status: 400 });
  const promo = (await listPromos()).find((x) => x.address.toLowerCase() === p.data.promo.toLowerCase());
  if (!promo || promo.meta.delivery) return NextResponse.json({ error: "This drop has nothing to deliver." }, { status: 404 });
  const buyer = await paidBuyer(promo, p.data.hash as Hex, p.data.secret as Hex).catch(() => null);
  if (!buyer) return NextResponse.json({ error: "We couldn't match this to your paid order. Try again in a few seconds." }, { status: 403 });
  const { name, phone, address, note } = p.data;
  await saveInfo(promo, await dropOwner(promo.seller), buyer, { name, phone, address, note: note || undefined });
  return NextResponse.json({ ok: true });
}
