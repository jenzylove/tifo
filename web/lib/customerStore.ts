// Where a seller's customers live: one small file per seller, sealed for that seller with the server key (the same seal
// as delivery details, lib/delivery.ts) and named by a keyed hash of their address, so the file can be neither read
// nor found without the server. Phone numbers never go on chain or out of a public API.
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { list, put } from "@vercel/blob";
import type { Address } from "viem";
import { mergeCustomers, ordersToCustomers, sessionMessage, type Customer, type OrderIn } from "./customers";
import { open, seal } from "./delivery";
import { listPromos } from "./promos";
import { dropOwner } from "./tifoAccount";

export interface CustomerBook {
  v: 1;
  customers: Customer[];
  sent: Record<string, string[]>; // drop address -> ids of customers the seller ticked as sent
  updatedAt: number;
}

const empty = (): CustomerBook => ({ v: 1, customers: [], sent: {}, updatedAt: 0 });

export const customersEnabled = () => (process.env.DELIVERY_SECRET ?? "").length >= 32;
const blobOn = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const secret = () => {
  const s = process.env.DELIVERY_SECRET;
  if (!s || s.length < 32) throw new Error("DELIVERY_SECRET is not set");
  return s;
};
const hmac = (label: string, text: string) => createHmac("sha256", secret()).update(`${label}:${text}`).digest("base64url");
const pathOf = (owner: string) => `customers/${hmac("customers-path", owner.toLowerCase()).slice(0, 32)}.json`;

// Without Blob (local runs) the list is kept in memory so the flow can still be tried.
const memory = new Map<string, string>();

export async function loadBook(owner: Address): Promise<CustomerBook> {
  const path = pathOf(owner);
  let sealed: string | null = null;
  if (!blobOn()) sealed = memory.get(path) ?? null;
  else {
    const { blobs } = await list({ prefix: path, limit: 1 });
    const b = blobs.find((x) => x.pathname === path);
    if (b) sealed = await (await fetch(`${b.url}?t=${Date.now()}`, { cache: "no-store" })).text();
  }
  if (!sealed) return empty();
  try {
    const book = JSON.parse(open(sealed, owner)) as CustomerBook;
    return { ...empty(), ...book };
  } catch {
    return empty();
  }
}

export async function saveBook(owner: Address, book: CustomerBook): Promise<CustomerBook> {
  const next = { ...book, v: 1 as const, customers: book.customers.slice(0, 2000), updatedAt: Math.floor(Date.now() / 1000) };
  const sealed = seal(JSON.stringify(next), owner);
  const path = pathOf(owner);
  if (!blobOn()) memory.set(path, sealed);
  else await put(path, sealed, { access: "public", contentType: "text/plain", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 });
  return next;
}

/** How many customers a seller saved. Never throws: the agent's advice only needs a count. */
export async function customerCount(owner: Address): Promise<number> {
  if (!customersEnabled()) return 0;
  return (await loadBook(owner).catch(() => empty())).customers.length;
}

/**
 * Buyers from guest checkout join the seller's list. `seller` may be the drop's seller (a Tifo account) or the
 * person behind it; the list is kept under the person. Each order: { phone, side or club, amountUsd, at, drop }.
 */
export async function mergeOrders(seller: Address, orders: OrderIn[]): Promise<{ added: number; total: number }> {
  if (!customersEnabled() || !orders.length) return { added: 0, total: 0 };
  const owner = await dropOwner(seller).catch(() => seller);
  const want = new Set(orders.map((o) => o.drop.toLowerCase()));
  const drops = Object.fromEntries(
    (await listPromos().catch(() => []))
      .filter((p) => want.has(p.address.toLowerCase()))
      .map((p) => [p.address.toLowerCase(), { teamA: p.meta.teamA, teamB: p.meta.teamB, product: p.meta.product }]),
  );
  const book = await loadBook(owner);
  const before = book.customers.length;
  book.customers = mergeCustomers(book.customers, ordersToCustomers(orders, drops));
  await saveBook(owner, book);
  return { added: book.customers.length - before, total: book.customers.length };
}

// A session: the seller signs once with their wallet; the server hands back a token good for 12 hours.
const SESSION_SECS = 12 * 3600;
export { sessionMessage };

export function issueToken(address: Address): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECS;
  const body = `${address.toLowerCase()}.${exp}`;
  return `${body}.${hmac("customers-session", body)}`;
}

export function checkToken(req: Request): Address | null {
  const raw = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const [addr, exp, mac] = raw.split(".");
  if (!addr || !exp || !mac || !/^0x[0-9a-f]{40}$/.test(addr)) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  const want = Buffer.from(hmac("customers-session", `${addr}.${exp}`));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return addr as Address;
}
