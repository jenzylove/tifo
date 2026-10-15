import { NextResponse } from "next/server";
import { isAddress, isHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { publicClient } from "@/lib/chain";
import { infoEnabled, readInfo, viewMessage } from "@/lib/deliveryInfo";
import { listPromos } from "@/lib/promos";
import { limit, tooMany } from "@/lib/ratelimit";
import { dropOwner } from "@/lib/tifoAccount";

const Body = z.object({ promo: z.string().refine(isAddress), at: z.number().int(), signature: z.string().refine(isHex) });

// The seller's buyers' addresses. The seller proves it is them by signing a fresh message with the wallet that owns the drop.
export async function POST(req: Request) {
  const rl = limit(req, "delivery-list", 30, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  if (!infoEnabled()) return NextResponse.json({ list: [] });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  if (Math.abs(Date.now() / 1000 - p.data.at) > 600) return NextResponse.json({ error: "That took too long. Try again." }, { status: 401 });
  const promo = (await listPromos()).find((x) => x.address.toLowerCase() === p.data.promo.toLowerCase());
  if (!promo) return NextResponse.json({ error: "unknown drop" }, { status: 404 });
  const owner: Address = await dropOwner(promo.seller);
  const ok = await publicClient.verifyMessage({ address: owner, message: viewMessage(promo.address, p.data.at), signature: p.data.signature as Hex }).catch(() => false);
  if (!ok) return NextResponse.json({ error: "Only the seller can see these." }, { status: 403 });
  return NextResponse.json({ list: await readInfo(promo, owner) }, { headers: { "cache-control": "no-store" } });
}
