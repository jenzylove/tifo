import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizePhone } from "@/lib/customers";
import { checkToken, customersEnabled, loadBook, saveBook } from "@/lib/customerStore";
import { limit, tooMany } from "@/lib/ratelimit";

const NO_STORE = { "cache-control": "no-store" };
const off = () => NextResponse.json({ error: "Customer lists are not set up on this site." }, { status: 503 });
const deny = () => NextResponse.json({ error: "Confirm it is you again." }, { status: 401 });

// The seller's own customers. Private: only with the token from /api/customers/session.
export async function GET(req: Request) {
  if (!customersEnabled()) return off();
  const owner = checkToken(req);
  if (!owner) return deny();
  const book = await loadBook(owner);
  return NextResponse.json({ customers: book.customers, sent: book.sent }, { headers: NO_STORE });
}

const Purchase = z.object({
  item: z.string().max(60).optional(),
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amountUsd: z.number().nonnegative().optional(),
  drop: z.string().max(42).optional(),
});
const Customer = z.object({
  id: z.string().min(1).max(20),
  name: z.string().trim().min(1).max(60),
  phone: z.string().max(30).nullable(),
  club: z.string().trim().max(40).optional(),
  purchases: z.array(Purchase).max(50),
  note: z.string().max(200).optional(),
  source: z.enum(["import", "order", "manual"]),
  addedAt: z.number().int(),
});
const Body = z.object({ customers: z.array(Customer).max(2000) });

/** Save the list after the seller edits or deletes customers. */
export async function PUT(req: Request) {
  const rl = limit(req, "customers-save", 60, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  if (!customersEnabled()) return off();
  const owner = checkToken(req);
  if (!owner) return deny();
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Check the names and numbers." }, { status: 400 });
  const customers = p.data.customers.map((c) => ({ ...c, phone: c.phone ? normalizePhone(c.phone) : null, club: c.club || undefined }));
  const book = await loadBook(owner);
  const ids = new Set(customers.map((c) => c.id));
  const sent = Object.fromEntries(Object.entries(book.sent).map(([d, xs]) => [d, xs.filter((x) => ids.has(x))]));
  const saved = await saveBook(owner, { ...book, customers, sent });
  return NextResponse.json({ customers: saved.customers, sent: saved.sent }, { headers: NO_STORE });
}
