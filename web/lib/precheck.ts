// Read the drop before paying, so a fan gets a plain reason instead of a raw revert from the bundler.
import type { Address } from "viem";
import { tifoPromoAbi } from "./abi";
import { publicClient } from "./chain";

export interface WalletInDrop {
  side: 0 | 1 | null; // the team this wallet already backed in this drop
}

export async function walletSide(promo: Address, buyer: Address): Promise<0 | 1 | null> {
  const s = Number(await publicClient.readContract({ address: promo, abi: tifoPromoAbi, functionName: "sideOf", args: [buyer] }));
  return s === 1 ? 0 : s === 2 ? 1 : null;
}

/** How an offer reads to a buyer. */
export function offerLabel(rateBps: number, team: string): string {
  if (rateBps >= 10_000) return `Free if ${team} win`;
  if (rateBps <= 0) return `${team}: no money back left`;
  return `${rateBps / 100}% back if ${team} win`;
}

/** The offer steps down when a side's budget is used up: the current rate, then the floor, then none. Same as _buy. */
export function stepDown(amount: bigint, rateBps: number, liability: bigint, cap: bigint, floorBps: number): number {
  const room = cap > liability ? cap - liability : 0n;
  let rate = rateBps;
  if ((amount * BigInt(rate)) / 10_000n > room) rate = floorBps;
  if ((amount * BigInt(rate)) / 10_000n > room) rate = 0;
  return rate;
}

/** Same checks the contract makes in _buy, in the same order. Returns a reason, or the offer this order will get. */
export async function precheck(promo: Address, buyer: Address, side: 0 | 1, amount: bigint, teams: [string, string]): Promise<{ error: string } | { rateBps: number }> {
  const c = { address: promo, abi: tifoPromoAbi } as const;
  const [closesAt, proposed, finalOutcome, sideOf, book, floorBps] = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: "closesAt" },
      { ...c, functionName: "proposed" },
      { ...c, functionName: "finalOutcome" },
      { ...c, functionName: "sideOf", args: [buyer] },
      { ...c, functionName: "book" },
      { ...c, functionName: "floorBps" },
    ],
  });
  if (Date.now() / 1000 >= Number(closesAt) || Number(proposed) !== 0 || Number(finalOutcome) !== 0) return { error: "This promo closed at kickoff." };
  const s = Number(sideOf);
  if (s !== 0 && s !== side + 1)
    return { error: `This wallet already took the ${teams[s - 1]} offer in this promo. Each wallet rides on one result, so you can add more ${teams[s - 1]} orders but not switch.` };
  const [rateA, rateB, la, lb, , cap] = book as readonly [number, number, bigint, bigint, bigint, bigint, bigint];
  return { rateBps: stepDown(amount, side === 0 ? rateA : rateB, side === 0 ? la : lb, cap, Number(floorBps)) };
}
