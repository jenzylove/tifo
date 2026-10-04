// The shop's numbers, read from its promo contracts on Arc. Used by the dashboard and the AI manager.
import "server-only";
import { erc20Abi, type Address } from "viem";
import { USDC, publicClient } from "./chain";
import { shortTeam } from "./matches";
import { listPromos, promoJournal, promoOrders, promoState, type PromoMeta } from "./promos";
import { shopOf, type Shop } from "./shops";

export interface DropRow {
  address: Address;
  meta: PromoMeta;
  closesAt: number;
  phase: "open" | "live" | "result" | "settled";
  outcome: string;
  rates: [number, number];
  orders: number;
  fans: number;
  sales: string; // USDC units as strings so the JSON survives
  held: string;
  refunded: string;
  cap: string;
  bySide: [number, number];
}

export interface FeedItem {
  at: number;
  drop: Address;
  match: string;
  kind: string;
  text: string;
}

export interface ManagerData {
  shop: Shop | null;
  drops: DropRow[];
  totals: { sales: string; received: string; held: string; refunded: string; fans: number; orders: number; live: number };
  feed: FeedItem[];
}

export async function managerData(seller: Address): Promise<ManagerData> {
  const [shop, all] = await Promise.all([shopOf(seller), listPromos()]);
  const mine = all.filter((p) => p.seller.toLowerCase() === seller.toLowerCase());
  const now = Date.now() / 1000;
  const feed: FeedItem[] = [];
  const buyers = new Set<string>();
  const drops = await Promise.all(
    mine.map(async (p): Promise<DropRow> => {
      const st = await promoState(p.address);
      const [orders, journal, held] = await Promise.all([
        promoOrders(p.address, st.ordersCount),
        promoJournal(p.address, st.journalCount),
        publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [p.address] }),
      ]);
      const match = `${shortTeam(p.meta.teamA)} v ${shortTeam(p.meta.teamB)}`;
      const team = [shortTeam(p.meta.teamA), shortTeam(p.meta.teamB)];
      for (const o of orders) {
        buyers.add(o.buyer.toLowerCase());
        feed.push({ at: o.at, drop: p.address, match, kind: "sale", text: `${team[o.side]} fan bought for $${(Number(o.amount) / 1e6).toFixed(2)} at ${o.rateBps / 100}% back` });
      }
      for (const j of journal) feed.push({ at: j.at, drop: p.address, match, kind: j.kind, text: j.text });
      const settled = st.finalOutcome !== "None";
      return {
        address: p.address,
        meta: p.meta,
        closesAt: p.closesAt,
        phase: settled ? "settled" : st.proposed !== "None" ? "result" : now >= st.closesAt ? "live" : "open",
        outcome: settled ? st.finalOutcome : st.proposed,
        rates: st.rates,
        orders: orders.length,
        fans: new Set(orders.map((o) => o.buyer.toLowerCase())).size,
        sales: orders.reduce((t, o) => t + o.amount, 0n).toString(),
        held: held.toString(),
        refunded: st.refundedTotal.toString(),
        cap: st.cap.toString(),
        bySide: [orders.filter((o) => o.side === 0).length, orders.filter((o) => o.side === 1).length],
      };
    }),
  );
  const sum = (k: "sales" | "held" | "refunded") => drops.reduce((t, d) => t + BigInt(d[k]), 0n);
  const sales = sum("sales"), held = sum("held"), refunded = sum("refunded");
  return {
    shop,
    drops: drops.sort((a, b) => b.closesAt - a.closesAt),
    totals: {
      sales: sales.toString(),
      received: (sales - held - refunded).toString(),
      held: held.toString(),
      refunded: refunded.toString(),
      fans: buyers.size,
      orders: drops.reduce((t, d) => t + d.orders, 0),
      live: drops.filter((d) => d.phase === "open" || d.phase === "live").length,
    },
    feed: feed.sort((a, b) => b.at - a.at).slice(0, 40),
  };
}
