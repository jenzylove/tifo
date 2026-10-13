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
  shape?: "percent" | "free"; // "free": a full refund for the first buyers on each side
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

export async function listPromos(src: Source = mainSource): Promise<PromoSummary[]> {
  const { factory: FACTORY, client: publicClient } = src;
  if (/^0x0+$/.test(FACTORY)) return [];
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
