// Everything about a promo is read from chain: the factory event carries its metadata,
// the promo contract carries the book, orders, decisions and refunds.
import { parseAbiItem, type Address } from "viem";
import { tifoPromoAbi } from "./abi";
import { FACTORY, FACTORY_BLOCK, publicClient } from "./chain";

export interface PromoMeta {
  slug: string;
  league: string;
  teamA: string;
  teamB: string;
  kickoff: string;
  shop: string;
  product: string;
  priceUsd: number;
  link?: string;
  baseRates: [number, number];
  minBps: number;
  maxBps: number;
  effectiveBps: number;
}

export interface PromoSummary {
  address: Address;
  seller: Address;
  closesAt: number;
  cap: bigint;
  meta: PromoMeta;
  createdTx: `0x${string}`;
}

const created = parseAbiItem(
  "event PromoCreated(address indexed promo, address indexed seller, bytes32 indexed fixtureId, uint64 closesAt, uint256 cap, string meta)",
);

const CHUNK = 9_000n;

async function getLogsChunked<T>(fn: (from: bigint, to: bigint) => Promise<T[]>, from: bigint): Promise<T[]> {
  const latest = await publicClient.getBlockNumber();
  const out: T[] = [];
  for (let start = from; start <= latest; start += CHUNK + 1n) {
    const end = start + CHUNK > latest ? latest : start + CHUNK;
    out.push(...(await fn(start, end)));
  }
  return out;
}

export async function listPromos(): Promise<PromoSummary[]> {
  if (/^0x0+$/.test(FACTORY)) return [];
  const logs = await getLogsChunked(
    (fromBlock, toBlock) => publicClient.getLogs({ address: FACTORY, event: created, fromBlock, toBlock }),
    FACTORY_BLOCK,
  );
  const out: PromoSummary[] = [];
  for (const l of logs) {
    try {
      out.push({
        address: l.args.promo!,
        seller: l.args.seller!,
        closesAt: Number(l.args.closesAt),
        cap: l.args.cap!,
        meta: JSON.parse(l.args.meta!) as PromoMeta,
        createdTx: l.transactionHash,
      });
    } catch {
      // metadata that doesn't parse is skipped, never guessed
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
  proposed: (typeof OUTCOMES)[number];
  proposedAt: number;
  finalOutcome: (typeof OUTCOMES)[number];
  refundCursor: number;
  remainderReleased: boolean;
  settleNotBefore: number;
  closesAt: number;
}

export async function promoState(address: Address): Promise<PromoState> {
  const c = { address, abi: tifoPromoAbi } as const;
  const [book, proposed, proposedAt, finalOutcome, refundCursor, remainderReleased, settleNotBefore, closesAt] = await publicClient.multicall({
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
    ],
  });
  const [rateA, rateB, la, lb, reserve, cap, count] = book as readonly [number, number, bigint, bigint, bigint, bigint, bigint];
  return {
    rates: [rateA, rateB],
    liability: [la, lb],
    reserve,
    cap,
    ordersCount: Number(count),
    proposed: OUTCOMES[Number(proposed)],
    proposedAt: Number(proposedAt),
    finalOutcome: OUTCOMES[Number(finalOutcome)],
    refundCursor: Number(refundCursor),
    remainderReleased: remainderReleased as boolean,
    settleNotBefore: Number(settleNotBefore),
    closesAt: Number(closesAt),
  };
}

export interface ActivityItem {
  kind: "sale" | "rates" | "decision" | "proposed" | "corrected" | "final" | "refund" | "remainder";
  tx: `0x${string}`;
  block: bigint;
  text: string;
  buyer?: Address;
  side?: number;
  amount?: bigint;
  rateBps?: number;
  held?: bigint;
  toSeller?: bigint;
}

export async function promoActivity(address: Address, fromBlock = FACTORY_BLOCK): Promise<ActivityItem[]> {
  const logs = await getLogsChunked(
    (from, to) => publicClient.getContractEvents({ address, abi: tifoPromoAbi, fromBlock: from, toBlock: to }),
    fromBlock,
  );
  const items: ActivityItem[] = [];
  for (const l of logs) {
    const a = l.args as Record<string, unknown>;
    const base = { tx: l.transactionHash, block: l.blockNumber };
    switch (l.eventName) {
      case "Sale":
        items.push({ ...base, kind: "sale", text: "", buyer: a.buyer as Address, side: Number(a.side), amount: a.amount as bigint, rateBps: Number(a.rateBps), held: a.held as bigint, toSeller: a.toSeller as bigint });
        break;
      case "RatesChanged":
        items.push({ ...base, kind: "rates", text: `Offers set to ${Number(a.rateA) / 100}% / ${Number(a.rateB) / 100}%. ${a.reason as string}` });
        break;
      case "Decision":
        items.push({ ...base, kind: "decision", text: `${a.kind as string}: ${a.reason as string}` });
        break;
      case "ResultProposed":
        items.push({ ...base, kind: "proposed", text: `Result proposed: ${OUTCOMES[Number(a.outcome)]}` });
        break;
      case "ResultCorrected":
        items.push({ ...base, kind: "corrected", text: `Result corrected by operator: ${OUTCOMES[Number(a.outcome)]}` });
        break;
      case "Finalized":
        items.push({ ...base, kind: "final", text: `Final: ${OUTCOMES[Number(a.outcome)]}` });
        break;
      case "Refunded":
        items.push({ ...base, kind: "refund", text: "Refund paid", buyer: a.buyer as Address, amount: a.amount as bigint });
        break;
      case "RemainderReleased":
        items.push({ ...base, kind: "remainder", text: "Leftover reserve returned to the seller", amount: a.amount as bigint });
        break;
    }
  }
  return items;
}
