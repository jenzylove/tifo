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
  const mark = (name: string) => /not for sale|\bcheck\b|testnet run|^(practice shop|ada studio)$/i.test(name);
  return mark(meta.product ?? "") || mark(meta.shop ?? "");
}

/**
 * Drops or sellers taken off Tifo by the operator (spam, a shop pretending to be someone else). HIDDEN_DROPS lists
 * addresses of either. A hidden drop is not shown, opened, relayed or worked on by the agent; its contract still lets
 * anyone settle it and every buyer claim what they are owed.
 */
const HIDDEN = new Set(((process.env.HIDDEN_DROPS ?? "").match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => a.toLowerCase()));
const isHidden = (p: PromoSummary) => HIDDEN.has(p.address.toLowerCase()) || HIDDEN.has(p.seller.toLowerCase());

export async function listPromos(src: Source = mainSource): Promise<PromoSummary[]> {
  const all = await Promise.all(
    [src.factory, ...(src.older ?? [])].filter((f) => !/^0x0+$/.test(f)).map((f) => fromFactory(f, src.client).catch(() => [] as PromoSummary[])),
  );
  return all
    .flat()
    .filter((p) => !isHidden(p))
    .sort((a, b) => b.closesAt - a.closesAt);
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
}

export async function promoState(address: Address, src: Source = mainSource): Promise<PromoState> {
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
  const [mb, nb] = await src.client.multicall({ allowFailure: true, contracts: [{ ...c, functionName: "minBuyers" }, { ...c, functionName: "buyers" }] });
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

export async function promoOrders(address: Address, count: number): Promise<Order[]> {
  const out: Order[] = [];
  for (let start = 0; start < count; start += 200) {
    const page = await publicClient.readContract({ address, abi: tifoPromoAbi, functionName: "getOrders", args: [BigInt(start), 200n] });
    for (const o of page)
      out.push({ buyer: o.buyer, side: o.side as 0 | 1, amount: o.amount, rateBps: o.rateBps, at: Number(o.at), refund: (o.amount * BigInt(o.rateBps)) / 10_000n });
  }
  return out;
}

export async function promoJournal(address: Address, count: number): Promise<JournalEntry[]> {
  if (!count) return [];
  const page = await publicClient.readContract({ address, abi: tifoPromoAbi, functionName: "getJournal", args: [0n, BigInt(count)] });
  return page.map((e) => ({ at: Number(e.at), kind: e.kind, text: e.text }));
}
