import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { z } from "zod";
import { checkToken, customersEnabled, loadBook, saveBook } from "@/lib/customerStore";

const Body = z.object({ drop: z.string().refine(isAddress), id: z.string().min(1).max(20), sent: z.boolean() });

/** The seller ticks a customer as messaged for a drop, or unticks them. */
export async function POST(req: Request) {
  if (!customersEnabled()) return NextResponse.json({ error: "Customer lists are not set up on this site." }, { status: 503 });
  const owner = checkToken(req);
  if (!owner) return NextResponse.json({ error: "Confirm it is you again." }, { status: 401 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const book = await loadBook(owner);
  const d = p.data.drop.toLowerCase();
  const now = new Set(book.sent[d] ?? []);
  if (p.data.sent) now.add(p.data.id);
  else now.delete(p.data.id);
  book.sent[d] = [...now];
  const saved = await saveBook(owner, book);
  return NextResponse.json({ sent: saved.sent }, { headers: { "cache-control": "no-store" } });
}
