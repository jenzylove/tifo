import { NextResponse } from "next/server";
import { decodeEventLog, isAddress, isHex, keccak256, type Hex } from "viem";
import { z } from "zod";
import { tifoPromoAbi } from "@/lib/abi";
import { publicClient } from "@/lib/chain";
import { isV1, open } from "@/lib/delivery";
import { listPromos } from "@/lib/promos";
import { dropOwner } from "@/lib/tifoAccount";

const Body = z.object({
  promo: z.string().refine(isAddress),
  hash: z.string().refine((s) => isHex(s) && s.length === 66),
  secret: z.string().refine((s) => isHex(s) && s.length === 66),
});

// A buyer opens their purchase. The order reference on chain is the hash of a secret that only the
// buyer's browser holds, so showing the secret next to the paid transaction proves the order is theirs.
// The order must have paid at least the price of one unit, and the sealed text must belong to this drop's seller.
export async function POST(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const promos = await listPromos();
  const promo = promos.find((x) => x.address.toLowerCase() === p.data.promo.toLowerCase());
  const sealed = promo?.meta.delivery;
  if (!promo || !sealed) return NextResponse.json({ error: "Nothing to open on this drop." }, { status: 404 });
  const price = BigInt(Math.round(Number(promo.meta.priceUsd) * 1e6));
  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: p.data.hash as Hex });
  } catch {
    return NextResponse.json({ error: "The payment isn't confirmed yet. Try again in a few seconds." }, { status: 409 });
  }
  const want = keccak256(p.data.secret as Hex);
  const paid =
    receipt.status === "success" &&
    receipt.logs.some((l) => {
      if (l.address.toLowerCase() !== promo.address.toLowerCase()) return false;
      try {
        const ev = decodeEventLog({ abi: tifoPromoAbi, data: l.data, topics: l.topics });
        if (ev.eventName !== "Sale") return false;
        const a = ev.args as { orderRef: Hex; amount: bigint };
        return a.orderRef === want && price > 0n && a.amount >= price;
      } catch {
        return false;
      }
    });
  if (!paid) return NextResponse.json({ error: "We couldn't match this to a paid order." }, { status: 403 });
  try {
    const owner = await dropOwner(promo.seller);
    if (isV1(sealed)) {
      // Older seals carry no owner. They open only on drops of the seller who first published them.
      const first = promos.filter((x) => x.meta.delivery === sealed).sort((a, b) => a.createdAt - b.createdAt)[0];
      if ((await dropOwner(first.seller)).toLowerCase() !== owner.toLowerCase()) throw new Error("copied seal");
    }
    return NextResponse.json({ delivery: open(sealed, owner) });
  } catch {
    return NextResponse.json({ error: "This drop's delivery can't be opened. Ask the seller." }, { status: 403 });
  }
}
