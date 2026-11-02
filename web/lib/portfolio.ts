// The agent runs a seller's drops like a small portfolio: a steady slice of the weekly rule per match week instead of
// one big offer, a stop after empty drops, and less offer where the product sells without it. Pure rules, no reads,
// so the planner and the tests share them. Every reason here goes on chain in the agent's own words.
import type { PromoMeta } from "./promos";

export const TIERS = [2_500, 5_000, 10_000] as const;
export const STEADY_SHARE = 1 / 3; // of the week's allowance, per drop
export const EMPTY_STOP = 2; // drops in a row with no orders before the agent stops opening drops

/** A drop as the rules need it. DropRow from manager.ts fits this shape. */
export interface DropLike {
  meta: Pick<PromoMeta, "product" | "priceUsd" | "backBps" | "shape" | "stock" | "profitUsd" | "teamA" | "teamB" | "delivery" | "slots">;
  phase: string;
  orders: number;
  cap: string; // USDC units
  byAgent?: boolean;
}

/**
 * What the seller keeps per sale, when they said. Drops made before the margin fix saved the full price as profit when
 * the cost was left blank, so a profit equal to the price is read as "not given".
 */
export function knownProfit(meta: Pick<PromoMeta, "priceUsd" | "profitUsd">): number | null {
  const p = meta.profitUsd;
  if (p === undefined || p === null || !(p > 0)) return null;
  if (p >= meta.priceUsd) return null;
  return p;
}

export const tierOf = (meta: DropLike["meta"]): number => meta.backBps ?? (meta.shape === "free" ? 10_000 : 5_000);

/** How many buyers the drop's budget covered at its offer. */
export function spotsOf(d: DropLike): number {
  const per = (d.meta.priceUsd * tierOf(d.meta)) / 10_000;
  return per > 0 ? Math.floor(Number(d.cap) / 1e6 / per + 1e-9) : 0;
}

/** Settled drops in a row, newest first, that sold nothing. A drop still running does not count either way. */
export function emptyStreak(drops: DropLike[]): number {
  let n = 0;
  for (const d of drops) {
    if (d.phase !== "settled") continue;
    if (d.orders > 0) break;
    n++;
  }
  return n;
}

export interface Advice {
  kind: "product" | "customers" | "stock" | "match";
  text: string;
}

/**
 * After EMPTY_STOP empty drops the agent stops and proposes a change instead of spending again. It never answers empty
 * drops with a bigger offer: the offer was not the problem when nobody saw the link.
 */
export function stopLoss(drops: DropLike[], customers: number): { halted: boolean; reason: string; advice: Advice[] } {
  const streak = emptyStreak(drops);
  if (streak < EMPTY_STOP) return { halted: false, reason: "", advice: [] };
  const last = drops.find((d) => d.phase === "settled")!;
  const stock = last.meta.stock ?? 0;
  const advice: Advice[] = [];
  advice.push(
    customers > 0
      ? { kind: "customers", text: `Send the next link to your ${customers} saved customers on WhatsApp. I write each one a message.` }
      : { kind: "customers", text: "Add the customers who bought from you before. I write each one a WhatsApp message with the link." },
  );
  if (stock > 3) advice.push({ kind: "stock", text: `Put up fewer: ${Math.max(3, Math.floor(stock / 2))} instead of ${stock}, so it sells out and looks wanted.` });
  advice.push({ kind: "product", text: `Try a different product. ${last.meta.product} has not sold in ${streak} drops.` });
  return {
    halted: true,
    reason: `Your last ${streak} drops got no orders, so I have stopped opening new ones. A bigger offer will not help if your buyers never see the link. Try one of the changes below and I start again once a drop sells.`,
    advice,
  };
}

/** The steady slice: a fixed share of the week's allowance, never more than what is left or the per drop limit. */
export function steadyBudget({ allowanceUsd, leftUsd, perDropUsd }: { allowanceUsd: number; leftUsd: number; perDropUsd: number }): number {
  const slice = allowanceUsd * STEADY_SHARE;
  return Math.max(0, Math.floor(Math.min(slice, leftUsd, perDropUsd) * 100) / 100);
}

const down = (t: number) => (t >= 10_000 ? 5_000 : 2_500);

/**
 * The offer for the next drop of this product. Starts from the model's pick and applies the portfolio rules:
 * never above the last drop's offer after it sold nothing; one step down when it sold past what the budget covered
 * (buyers came without needing the offer); no free drops while the margin is unknown.
 */
export function chooseTier(
  modelTier: number,
  last: DropLike | undefined,
  marginKnown: boolean,
): { tier: number; why: string | null } {
  let tier = (TIERS as readonly number[]).includes(modelTier) ? modelTier : 5_000;
  let why: string | null = null;
  if (last && last.phase === "settled") {
    const lastTier = tierOf(last.meta);
    const spots = spotsOf(last);
    if (last.orders === 0 && tier > lastTier) {
      tier = lastTier;
      why = `I kept the offer at ${lastTier / 100}% back: the last drop sold nothing, and a bigger offer does not fix a link nobody saw.`;
    } else if (last.orders > 0 && spots > 0 && last.orders > spots) {
      const lower = down(lastTier);
      if (tier > lower || lastTier > lower) {
        tier = Math.min(tier, lower);
        why = `I lowered the offer to ${tier / 100}% back: last time ${last.orders} bought while the budget covered ${spots}, so this product sells without the full offer.`;
      }
    }
  }
  if (!marginKnown && tier > 5_000) {
    tier = 5_000;
    why = (why ? `${why} ` : "") + "I kept it at 50% back because I do not know what one costs you. Add it on your next drop.";
  }
  return { tier, why };
}

/** The product that sold best in recent drops, so the next drop starts from what converted. Newest wins a tie. */
export function bestTemplate<T extends DropLike>(drops: T[]): T {
  const settled = drops.filter((d) => d.phase === "settled").slice(0, 6);
  const by = new Map<string, { n: number; orders: number; first: T }>();
  for (const d of settled) {
    if (d.meta.slots?.length) continue; // bookings need the seller's own times
    const k = d.meta.product.trim().toLowerCase();
    const e = by.get(k) ?? { n: 0, orders: 0, first: d };
    e.n++;
    e.orders += d.orders;
    by.set(k, e);
  }
  let best: { avg: number; first: T } | null = null;
  for (const e of by.values()) {
    const avg = e.orders / e.n;
    if (avg > 0 && (!best || avg > best.avg)) best = { avg, first: e.first };
  }
  return best?.first ?? drops[0];
}

/** Clubs whose fans bought before, most first. Given to the model so it prefers matches with those clubs. */
export function clubsThatSold(drops: (DropLike & { bySide?: [number, number] })[]): { club: string; orders: number }[] {
  const m = new Map<string, number>();
  for (const d of drops) {
    if (!d.bySide) continue;
    const [a, b] = d.bySide;
    if (a) m.set(d.meta.teamA, (m.get(d.meta.teamA) ?? 0) + a);
    if (b) m.set(d.meta.teamB, (m.get(d.meta.teamB) ?? 0) + b);
  }
  return [...m.entries()].map(([club, orders]) => ({ club, orders })).sort((x, y) => y.orders - x.orders).slice(0, 8);
}

/** How many buyers must buy before the offer switches on: never more than a third of the stock, at most 10. */
export function capThreshold(minBuyers: number, stock: number | null): number {
  const want = Math.max(0, Math.floor(minBuyers || 0));
  if (!stock) return Math.min(10, want);
  return Math.min(10, want, Math.floor(stock / 3));
}

/**
 * The most a drop may put at risk given the margin. Known margin: at most half of what the full stock earns.
 * Unknown margin: treated as thin, at most a quarter of the stock's price.
 */
export function marginCap(priceUsd: number, stock: number | null, profit: number | null): number | null {
  if (!stock) return null;
  return profit !== null ? profit * stock * 0.5 : priceUsd * stock * 0.25;
}
