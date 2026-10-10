import { NextResponse } from "next/server";
import { decodeEventLog, isAddress, isHex, keccak256, type Hex } from "viem";
import { z } from "zod";
import { tifoPromoAbi } from "@/lib/abi";
import { publicClient } from "@/lib/chain";
import { open } from "@/lib/delivery";
import { listPromos } from "@/lib/promos";

const Body = z.object({
  promo: z.string().refine(isAddress),
  hash: z.string().refine((s) => isHex(s) && s.length === 66),
  secret: z.string().refine((s) => isHex(s) && s.length === 66),
});

// A buyer opens their purchase. The order reference on chain is the hash of a secret that only the
// buyer's browser holds, so showing the secret next to the paid transaction proves the order is theirs.
export async function POST(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const promo = (await listPromos()).find((x) => x.address.toLowerCase() === p.data.promo.toLowerCase());
  if (!promo?.meta.delivery) return NextResponse.json({ error: "Nothing to open on this drop." }, { status: 404 });
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: p.data.hash as Hex });
    if (receipt.status !== "success") throw new Error("not paid");
    const want = keccak256(p.data.secret as Hex);
    const paid = receipt.logs.some((l) => {
      if (l.address.toLowerCase() !== promo.address.toLowerCase()) return false;
      try {
        const ev = decodeEventLog({ abi: tifoPromoAbi, data: l.data, topics: l.topics });
        return ev.eventName === "Sale" && (ev.args as { orderRef: Hex }).orderRef === want;
      } catch {
        return false;
      }
    });
    if (!paid) return NextResponse.json({ error: "We couldn't match this to a paid order." }, { status: 403 });
    return NextResponse.json({ delivery: open(promo.meta.delivery) });
  } catch {
    return NextResponse.json({ error: "The payment isn't confirmed yet. Try again in a few seconds." }, { status: 409 });
  }
}
