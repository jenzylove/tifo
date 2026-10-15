// Drops for public boards (landing, /drops).
import "server-only";
import type { DropCardData } from "@/components/DropCard";
import { isCheckDrop, listPromos, promoState, type PromoSummary } from "./promos";
import { NETWORK, usd, mainSource, type Source } from "./chain";
import { dropOwner } from "./tifoAccount";

// Anyone can open a drop straight on the factory, with any shop name and photo. Drops made since this moment are shown
// on the public boards only when they were opened through a Tifo account, the way the app opens every drop.
const LISTED_SINCE = 1_792_080_000; // 15 Oct 2026, 16:00 UTC
const viaAccount = new Map<string, Promise<boolean>>();

function listed(p: PromoSummary, src: Source): Promise<boolean> {
  if (NETWORK !== "mainnet" || src !== mainSource || p.createdAt < LISTED_SINCE) return Promise.resolve(true);
  const key = p.seller.toLowerCase();
  if (!viaAccount.has(key)) viaAccount.set(key, dropOwner(p.seller).then((o) => o.toLowerCase() !== key).catch(() => false));
  return viaAccount.get(key)!;
}

export async function dropCards(filter?: (seller: string) => boolean, limit = 24, src: Source = mainSource): Promise<DropCardData[]> {
  const candidates = (await listPromos(src)).filter((p) => !isCheckDrop(p.meta) && (!filter || filter(p.seller.toLowerCase())));
  const shown = await Promise.all(candidates.map((p) => listed(p, src)));
  const promos = candidates.filter((_, i) => shown[i]).slice(0, limit);
  const now = Date.now() / 1000;
  return Promise.all(
    promos.map(async (p) => {
      const st = await promoState(p.address, src);
      const settled = st.finalOutcome !== "None";
      const phase = settled ? "settled" : st.proposed !== "None" ? "result" : now >= st.closesAt ? "live" : "open";
      const note = settled
        ? st.finalOutcome === "A" || st.finalOutcome === "B"
          ? `${usd(st.refundedTotal)} paid back to winning fans`
          : st.finalOutcome === "Draw"
            ? st.refundedTotal > 0n
              ? `Draw: ${usd(st.refundedTotal)} thank you paid to every buyer`
              : "Draw: no rebates"
            : "Voided"
        : undefined;
      return { p, rates: st.rates, phase, fans: st.ordersCount, note } as DropCardData;
    }),
  );
}
