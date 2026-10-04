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

/** Same checks the contract makes in _buy, in the same order. Returns a reason, or null if the order will go through. */
export async function precheck(promo: Address, buyer: Address, side: 0 | 1, amount: bigint, teams: [string, string]): Promise<string | null> {
  const c = { address: promo, abi: tifoPromoAbi } as const;
  const [closesAt, proposed, finalOutcome, sideOf, book] = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: "closesAt" },
      { ...c, functionName: "proposed" },
      { ...c, functionName: "finalOutcome" },
      { ...c, functionName: "sideOf", args: [buyer] },
      { ...c, functionName: "book" },
    ],
  });
  if (Date.now() / 1000 >= Number(closesAt) || Number(proposed) !== 0 || Number(finalOutcome) !== 0) return "This promo closed at kickoff.";
  const s = Number(sideOf);
  if (s !== 0 && s !== side + 1)
    return `This wallet already took the ${teams[s - 1]} offer in this promo. Each wallet rides on one result, so you can add more ${teams[s - 1]} orders but not switch.`;
  const [rateA, rateB, la, lb, , cap] = book as readonly [number, number, bigint, bigint, bigint, bigint, bigint];
  const liab = [la, lb];
  liab[side] += (amount * BigInt(side === 0 ? rateA : rateB)) / 10_000n;
  const need = liab[0] > liab[1] ? liab[0] : liab[1];
  if (need > cap) return `The shop's budget for the ${teams[side]} offer is used up at this size. Try fewer items or the other offer.`;
  return null;
}
