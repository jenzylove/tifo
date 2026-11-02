// Everything about a promo is read from contract storage: the factory holds each promo's metadata,
// the promo holds its book, orders and the agent's decision journal. No log scanning, so reads stay
// a few batched calls however old a promo is.
import type { Address } from "viem";
import { tifoFactoryAbi, tifoPromoAbi } from "./abi";
import { mainSource, publicClient, type Source } from "./chain";

export interface PromoMeta {
  slug: string;
  league: string;
  teamA: string;
  teamB: string;
  kickoff: string;
  shop: string;
  product: string;
  priceUsd: number;
  image?: string;
  link?: string;
  description?: string;
  profitUsd?: number; // what the seller keeps per sale before the promo, for the break-even line
  delivery?: string; // sealed; opened only for a paid order (see lib/delivery.ts)
  byAgent?: boolean; // the agent opened this drop by itself, inside the seller's rule
  practice?: boolean; // opened on the practice version (Arc testnet) to try the flow with test USDC
  reason?: string; // why the agent chose this match and these terms
  contact?: string; // where a buyer sends delivery details for a physical product
  shape?: "percent" | "free" | "back"; // "free": 100% back; "back": a fixed tier (25% or 50%) back; "percent": older odds-based drops
  backBps?: number; // the tier the seller chose: 2500, 5000 or 10000
  slots?: string[]; // a bookable service: the times on offer (ISO). Stock is the number of slots
  stock?: number; // how many the seller has; with backBps it sets the cap (stock x price x share back)
  minBuyers?: number; // the offer only pays out once this many people bought (the contract holds the real value)
  refNeeded?: number; // a buyer who brings this many friends gets their order free (the contract holds the real value)
  baseRates: [number, number];
  minBps: number;
  maxBps: number;
  effectiveBps: number;
}

export interface PromoSummary {
  address: Address;
  seller: Address;
  closesAt: number;
  createdAt: number;
  cap: bigint;
  meta: PromoMeta;
}

/**
 * Drops we opened ourselves only to check the system (labelled "check" or "not for sale", or from our own test shop).
 * They stay on chain and are listed apart on /proof, but they are not shown to shoppers and never counted as usage.
 */
export function isCheckDrop(meta: Pick<PromoMeta, "product" | "shop">): boolean {
  const mark = (name: string) => /not for sale|\bcheck\b|testnet run|^(practice shop|ada studio|test)$/i.test((name ?? "").trim());
  return mark(meta.product ?? "") || mark(meta.shop ?? "");
}

/**
 * Drops or sellers taken off Tifo by the operator (spam, a shop pretending to be someone else). HIDDEN_DROPS lists
 * addresses of either. A hidden drop is not shown, opened, relayed or worked on by the agent; its contract still lets
 * anyone settle it and every buyer claim what they are owed.
 */
const HIDDEN = new Set(((process.env.HIDDEN_DROPS ?? "").match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => a.toLowerCase()));
const isHidden = (p: PromoSummary) => HIDDEN.has(p.address.toLowerCase()) || HIDDEN.has(p.seller.toLowerCase());

/**
 * The operator's own wallets (SELF_WALLETS, server only, comma separated). Drops they sell and orders they place are
 * never counted as usage on /proof or the home page: our own testing is not traction.
 */
const SELF = new Set(((process.env.SELF_WALLETS ?? "").match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => a.toLowerCase()));
export const isOwnWallet = (a: string) => SELF.has(a.toLowerCase());
export const isOwnSeller = (p: Pick<PromoSummary, "seller">) => isOwnWallet(p.seller);

/** Refund money that went to the operator's own wallets on a settled A or B result (orders are paid in order, up to the cursor). */
export function ownRefundsPaid(st: Pick<PromoState, "finalOutcome" | "refundCursor">, orders: Order[]): bigint {
  const win = st.finalOutcome === "A" ? 0 : st.finalOutcome === "B" ? 1 : -1;
  return orders.reduce((t, o, i) => (isOwnWallet(o.buyer) && o.side === win && i < st.refundCursor ? t + o.refund : t), 0n);
}

// Reads that feed the public pages are kept for a short while and, when the node fails, the last good answer is served
// instead of an empty one. A failed read must never look like "no drops". Callers that move money use the strict
// variants, which never serve old data.
const FRESH_MS = 20_000;
const RETRY_MS = 400;
interface Slot<T> {
  at: number;
  value?: T;
  pending?: Promise<T>;
}
const slots = new Map<string, Slot<unknown>>();

async function once<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    await new Promise((r) => setTimeout(r, RETRY_MS));
    return read();
  }
}

/** Fresh value if young enough, else read (retrying once); if that fails, the last good value; if there is none, the error. */
export async function cachedRead<T>(key: string, read: () => Promise<T>, maxAgeMs = FRESH_MS): Promise<T> {
  const slot = (slots.get(key) as Slot<T> | undefined) ?? { at: 0 };
  slots.set(key, slot);
  if (slot.value !== undefined && Date.now() - slot.at < maxAgeMs) return slot.value;
  slot.pending ??= once(read).finally(() => (slot.pending = undefined));
  try {
    const v = await slot.pending;
    slot.value = v;
    slot.at = Date.now();
    return v;
  } catch (e) {
    if (slot.value !== undefined) {
      console.error("read failed, serving the last good result", (e as Error).message);
      return slot.value;
    }
    throw e;
  }
}

/** Every promo on the source, or an error. Used where a failed read must stop the work instead of looking like an empty list. */
export async function listPromosStrict(src: Source = mainSource): Promise<PromoSummary[]> {
  const all = await Promise.all(
    [src.factory, ...(src.older ?? [])].filter((f) => !/^0x0+$/.test(f)).map((f) => once(() => fromFactory(f, src.client))),
  );
  return all
    .flat()
    .filter((p) => !isHidden(p))
    .sort((a, b) => b.closesAt - a.closesAt);
}

/** The same list for pages: cached for a few seconds, the last good list when the node fails, an error only when there never was one. */
export function listPromos(src: Source = mainSource): Promise<PromoSummary[]> {
  return cachedRead(`list:${src.factory}`, () => listPromosStrict(src));
}

async function fromFactory(FACTORY: Address, publicClient: Source["client"]): Promise<PromoSummary[]> {
  const count = Number(await publicClient.readContract({ address: FACTORY, abi: tifoFactoryAbi, functionName: "promosCount" }));
  const out: PromoSummary[] = [];
  for (let start = 0; start < count; start += 100) {
    const page = await publicClient.readContract({ address: FACTORY, abi: tifoFactoryAbi, functionName: "getPromos", args: [BigInt(start), 100n] });
    for (const p of page) {
      try {
        out.push({
          address: p.promo,
          seller: p.seller,
          closesAt: Number(p.closesAt),
          createdAt: Number(p.createdAt),
          cap: p.cap,
          meta: JSON.parse(p.meta) as PromoMeta,
        });
      } catch {
        // metadata that doesn't parse is skipped, never guessed
      }
    }
  }
  return out.sort((a, b) => b.closesAt - a.closesAt);
}

export const OUTCOMES = ["None", "A", "B", "Draw", "Void"] as const;

export interface PromoState {
  rates: [number, number];
  liability: [bigint, bigint];
  reserve: bigint;
  cap: bigint;
  ordersCount: number;
  journalCount: number;
  proposed: (typeof OUTCOMES)[number];
  proposedAt: number;
  finalOutcome: (typeof OUTCOMES)[number];
  refundCursor: number;
  refundedTotal: bigint;
  remainderReleased: boolean;
  settleNotBefore: number;
  closesAt: number;
  floorBps: number;
  drawBps: number;
  drawLiability: bigint;
  minBuyers: number; // 0 or 1: the offer works from the first sale
  buyers: number; // different wallets that bought
  refNeeded: number; // friends a buyer must bring for a free order; 0 when the drop has no referrals
}

/** For pages: cached briefly, the last good state if the node fails. */
export function promoState(address: Address, src: Source = mainSource): Promise<PromoState> {
  return cachedRead(`state:${src.factory}:${address.toLowerCase()}`, () => promoStateFresh(address, src));
}

/** For the agent: always read now, and throw if the read fails. */
export async function promoStateFresh(address: Address, src: Source = mainSource): Promise<PromoState> {
  const c = { address, abi: tifoPromoAbi } as const;
  const r = await src.client.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: "book" },
      { ...c, functionName: "proposed" },
      { ...c, functionName: "proposedAt" },
      { ...c, functionName: "finalOutcome" },
      { ...c, functionName: "refundCursor" },
      { ...c, functionName: "remainderReleased" },
      { ...c, functionName: "settleNotBefore" },
      { ...c, functionName: "closesAt" },
      { ...c, functionName: "journalCount" },
      { ...c, functionName: "refundedTotal" },
      { ...c, functionName: "floorBps" },
      { ...c, functionName: "drawBps" },
      { ...c, functionName: "drawLiability" },
    ],
  });
  const [rateA, rateB, la, lb, reserve, cap, count] = r[0] as readonly [number, number, bigint, bigint, bigint, bigint, bigint];
  // Drops made before the threshold existed do not have these two; they work from the first sale.
  const [mb, nb, rn] = await src.client.multicall({ allowFailure: true, contracts: [{ ...c, functionName: "minBuyers" }, { ...c, functionName: "buyers" }, { ...c, functionName: "refNeeded" }] });
  return {
    rates: [rateA, rateB],
    liability: [la, lb],
    reserve,
    cap,
    ordersCount: Number(count),
    proposed: OUTCOMES[Number(r[1])],
    proposedAt: Number(r[2]),
    finalOutcome: OUTCOMES[Number(r[3])],
    refundCursor: Number(r[4]),
    remainderReleased: r[5] as boolean,
    settleNotBefore: Number(r[6]),
    closesAt: Number(r[7]),
    journalCount: Number(r[8]),
    refundedTotal: r[9] as bigint,
    floorBps: Number(r[10]),
    drawBps: Number(r[11]),
    drawLiability: r[12] as bigint,
    minBuyers: mb.status === "success" ? Number(mb.result) : 0,
    buyers: nb.status === "success" ? Number(nb.result) : 0,
    refNeeded: rn.status === "success" ? Number(rn.result) : 0,
  };
}

export interface Order {
  buyer: Address;
  side: 0 | 1;
  amount: bigint;
  rateBps: number;
  at: number;
  refund: bigint; // what this order gets back if its side wins
}

export interface JournalEntry {
  at: number;
  kind: string;
  text: string;
}

export function promoOrders(address: Address, count: number): Promise<Order[]> {
  return cachedRead(`orders:${address.toLowerCase()}:${count}`, () => readOrders(address, count));
}

async function readOrders(address: Address, count: number): Promise<Order[]> {
  const out: Order[] = [];
  for (let start = 0; start < count; start += 200) {
    const page = await publicClient.readContract({ address, abi: tifoPromoAbi, functionName: "getOrders", args: [BigInt(start), 200n] });
    for (const o of page)
      out.push({ buyer: o.buyer, side: o.side as 0 | 1, amount: o.amount, rateBps: o.rateBps, at: Number(o.at), refund: (o.amount * BigInt(o.rateBps)) / 10_000n });
  }
  return out;
}

export function promoJournal(address: Address, count: number): Promise<JournalEntry[]> {
  return count ? cachedRead(`journal:${address.toLowerCase()}:${count}`, () => readJournal(address, count)) : Promise.resolve([]);
}

async function readJournal(address: Address, count: number): Promise<JournalEntry[]> {
  const page = await publicClient.readContract({ address, abi: tifoPromoAbi, functionName: "getJournal", args: [0n, BigInt(count)] });
  return page.map((e) => ({ at: Number(e.at), kind: e.kind, text: e.text }));
}
