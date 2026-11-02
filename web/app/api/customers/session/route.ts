import { NextResponse } from "next/server";
import { isAddress, isHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { publicClient } from "@/lib/chain";
import { customersEnabled, issueToken, sessionMessage } from "@/lib/customerStore";
import { limit, tooMany } from "@/lib/ratelimit";

const Body = z.object({ address: z.string().refine(isAddress), at: z.number().int(), signature: z.string().refine(isHex) });

// The seller signs a fresh message with their wallet, the same proof the delivery list uses. Back comes a 12 hour token,
// so they confirm once, not on every change.
export async function POST(req: Request) {
  const rl = limit(req, "customers-session", 20, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  if (!customersEnabled()) return NextResponse.json({ error: "Customer lists are not set up on this site." }, { status: 503 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  if (Math.abs(Date.now() / 1000 - p.data.at) > 600) return NextResponse.json({ error: "That took too long. Try again." }, { status: 401 });
  const address = p.data.address as Address;
  const ok = await publicClient.verifyMessage({ address, message: sessionMessage(address, p.data.at), signature: p.data.signature as Hex }).catch(() => false);
  if (!ok) return NextResponse.json({ error: "Only the shop owner can open this list." }, { status: 403 });
  return NextResponse.json({ token: issueToken(address) }, { headers: { "cache-control": "no-store" } });
}
