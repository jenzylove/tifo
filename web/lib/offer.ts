// The offer a seller can run: a fixed share of the price back if the buyer's team wins.
// Round tiers only, so a drop reads like a promo ("50% back if Arsenal win"), never like odds.
export const TIERS = [2_500, 5_000, 10_000] as const;
export type Tier = (typeof TIERS)[number];
export const FULL = 10_000;

export const tierLabel = (bps: number) => (bps >= FULL ? "Free" : `${bps / 100}% back`);

/** Buyers one side can still cover at this offer, from what is left of the budget. */
export function coverLeft(cap: bigint, liability: bigint, priceUnits: bigint, rateBps: number): number | null {
  if (priceUnits <= 0n || rateBps <= 0) return null;
  const room = cap > liability ? cap - liability : 0n;
  return Number((room * 10_000n) / (priceUnits * BigInt(rateBps)));
}

/** Only shown when nearly gone, so a drop reads as open to everyone until it really is not. */
export const LOW = 2;
export const lastFew = (n: number | null) => (n !== null && n > 0 && n <= LOW ? `Only ${n} left` : null);
