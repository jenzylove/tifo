import { NextResponse } from "next/server";
import { z } from "zod";
import { importCustomers } from "@/lib/customerImport";
import { mergeCustomers } from "@/lib/customers";
import { checkToken, customersEnabled, loadBook, saveBook } from "@/lib/customerStore";
import { limit, tooMany } from "@/lib/ratelimit";

export const maxDuration = 120;

const Body = z.object({
  text: z.string().max(400_000).optional(), // a pasted list or a WhatsApp chat export
  // a screenshot, sent inline and never stored
  image: z.object({ data: z.string().max(5_000_000), mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]) }).optional(),
  shop: z.string().max(60).nullable().optional(),
});

/** Read customers from a list, a chat export or a screenshot, and add them to the seller's private list. */
export async function POST(req: Request) {
  const rl = limit(req, "customers-import", 10, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  if (!customersEnabled()) return NextResponse.json({ error: "Customer lists are not set up on this site." }, { status: 503 });
  const owner = checkToken(req);
  if (!owner) return NextResponse.json({ error: "Confirm it is you again." }, { status: 401 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success || (!p.data.text?.trim() && !p.data.image)) return NextResponse.json({ error: "Paste a list, or add a chat export or a screenshot." }, { status: 400 });
  try {
    const { customers, byModel } = await importCustomers({ text: p.data.text, image: p.data.image, shop: p.data.shop ?? null });
    const book = await loadBook(owner);
    const before = book.customers.length;
    book.customers = mergeCustomers(book.customers, customers);
    const saved = await saveBook(owner, book);
    return NextResponse.json(
      { customers: saved.customers, sent: saved.sent, found: customers.length, added: saved.customers.length - before, byModel },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    console.error(e);
    const m = (e as Error).message;
    return NextResponse.json({ error: m.startsWith("We couldn't") ? m : "We couldn't read that. Try pasting the names and numbers." }, { status: 502 });
  }
}
