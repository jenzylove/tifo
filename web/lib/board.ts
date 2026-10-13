// Drops for public boards (landing, /drops).
import "server-only";
import type { DropCardData } from "@/components/DropCard";
import { listPromos, promoState } from "./promos";
import { usd, mainSource, type Source } from "./chain";

export async function dropCards(filter?: (seller: string) => boolean, limit = 24, src: Source = mainSource): Promise<DropCardData[]> {
  // Drops we opened only to check the system (labelled "check" or "not for sale") stay on chain and on /proof,
  // but are not shown to shoppers on the boards.
  const isCheck = (name: string) => /not for sale|\bcheck\b|testnet run|^(practice shop|ada studio)$/i.test(name);
  const promos = (await listPromos(src))
    .filter((p) => !isCheck(p.meta.product) && !isCheck(p.meta.shop ?? "") && (!filter || filter(p.seller.toLowerCase())))
    .slice(0, limit);
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
