// The seller's numbers, read from their drop contracts on Arc. Used by the dashboard and the AI manager.
import "server-only";
import { erc20Abi, type Address } from "viem";
import { USDC, explorerAddr, publicClient, usd } from "./chain";
import { shortTeam } from "./matches";
import { listPromos, promoJournal, promoOrders, promoState, type PromoMeta } from "./promos";
import { readDeliveries } from "./shipments";
import { accountOf, accountState, type AccountState } from "./tifoAccount";

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
  byAgent: boolean; // opened by the agent inside the seller's rule
  reconciled: boolean; // the contract holds exactly what the book says it owes, to the cent
  extraSalesToBreakEven: number | null; // refunds paid / profit per sale, when the seller gave their profit
}

export interface FeedItem {
  at: number;
  drop: Address;
  match: string;
  kind: string;
  text: string;
}

/** One line of the seller's books: money in, money out, or a decision the agent took, each with its reason. */
export interface BookLine {
  at: number;
  kind: "in" | "back" | "out" | "decision" | "asked";
  amount: string | null; // signed USDC units; null when no money moved
  title: string;
  why: string;
  link: string; // the contract on the explorer where this can be checked
  drop?: Address;
}

export interface Books {
  lines: BookLine[]; // newest first
  moneyIn: string; // paid by buyers
  paidBack: string; // returned to buyers whose team won (or the draw thank you)
  sentToSeller: string; // reached the seller: paid out by the agent, or straight to their wallet on older drops
  held: string; // still inside drops for refunds and deliveries, plus anything in the account about to be sent
  alone: number; // actions the agent took by itself: drops opened inside the rule, results settled, payouts sent
  asked: number; // times it went over the rule and asked first
  agreed: number; // of those, how many the seller approved
  pairs: number; // buyers who came from another buyer's challenge link
  settled: number; // drops whose result was settled and paid with nobody clicking
  due: number; // drops whose match has ended
}

export interface ManagerData {
  name: string | null; // the seller name used on their latest drop
  account: AccountState | null; // the seller's standing rule for the agent, if they opened one
  drops: DropRow[];
  totals: { sales: string; received: string; held: string; refunded: string; fans: number; orders: number; live: number };
  feed: FeedItem[];
  books: Books;
}

export async function managerData(seller: Address): Promise<ManagerData> {
  const [all, accountAddress] = await Promise.all([listPromos(), accountOf(seller).catch(() => null)]);
  const owners = [seller.toLowerCase(), accountAddress?.toLowerCase()];
  const mine = all.filter((p) => owners.includes(p.seller.toLowerCase()));
  const account = accountAddress ? await accountState(accountAddress) : null;
  const now = Date.now() / 1000;
  const feed: FeedItem[] = [];
  const lines: BookLine[] = [];
  const buyers = new Set<string>();
  let settledCount = 0, dueCount = 0, pairCount = 0;
  const drops = await Promise.all(
    mine.map(async (p): Promise<DropRow> => {
      const st = await promoState(p.address);
      const [orders, journal, held, deliveries] = await Promise.all([
        promoOrders(p.address, st.ordersCount),
        promoJournal(p.address, st.journalCount),
        publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [p.address] }),
        st.ordersCount ? readDeliveries(p.address, st.ordersCount).catch(() => null) : Promise.resolve(null),
      ]);
      const match = `${shortTeam(p.meta.teamA)} v ${shortTeam(p.meta.teamB)}`;
      const team = [shortTeam(p.meta.teamA), shortTeam(p.meta.teamB)];
      const link = explorerAddr(p.address);
      orders.forEach((o, i) => {
        buyers.add(o.buyer.toLowerCase());
        feed.push({ at: o.at, drop: p.address, match, kind: "sale", text: `${team[o.side]} fan bought for $${(Number(o.amount) / 1e6).toFixed(2)} at ${o.rateBps / 100}% back` });
        // A product that ships: the seller's share waits in the drop until the buyer has it.
        const ship = deliveries?.list[i]?.state;
        const rest =
          ship === "Held" ? "The rest waits in the drop until you mark it sent and the buyer confirms it arrived."
          : ship === "Sent" || ship === "Disputed" ? "The rest waits in the drop until the buyer confirms it arrived."
          : ship === "Refunded" ? "The rest went back to the buyer because the order was not delivered."
          : "The rest is yours now.";
        lines.push({
          at: o.at, kind: "in", amount: o.amount.toString(), drop: p.address, link,
          title: `${p.meta.product}, bought by a ${team[o.side]} fan`,
          why: o.refund > 0n ? `${usd(o.refund)} of it is kept inside the drop until full time, in case ${team[o.side]} win. ${rest}` : `Nothing is owed back on this order if their team wins. ${rest}`,
        });
      });
      for (const j of journal) {
        if (j.kind === "pair") {
          // "0x… (Arsenal) brought 0x… (Lille)": one buyer's challenge link brought the next.
          const m = /\((.+?)\) brought 0x[0-9a-f]{40} \((.+?)\)/i.exec(j.text);
          const said = m ? `A ${m[1]} fan challenged a ${m[2]} fan, who bought too` : "One buyer brought another with the challenge link";
          pairCount++;
          feed.push({ at: j.at, drop: p.address, match, kind: "pair", text: said });
          lines.push({ at: j.at, kind: "decision", amount: null, drop: p.address, link, title: said, why: "That second sale came from your buyer's challenge link, not from your own post." });
          continue;
        }
        feed.push({ at: j.at, drop: p.address, match, kind: j.kind, text: j.text });
        if (j.kind === "rates") lines.push({ at: j.at, kind: "decision", amount: null, drop: p.address, link, title: `Moved the offers on ${match}`, why: j.text });
      }
      const settled = st.finalOutcome !== "None";
      if (now >= st.settleNotBefore) dueCount++;
      if (settled) {
        settledCount++;
        const at = [...journal].reverse().find((j) => j.kind === "final")?.at ?? st.settleNotBefore;
        const sources = [...journal].reverse().find((j) => j.kind === "result")?.text ?? "Result checked against three sources.";
        const winner = st.finalOutcome === "A" ? team[0] : st.finalOutcome === "B" ? team[1] : null;
        const paid = winner ? orders.filter((o) => team[o.side] === winner && o.refund > 0n).length : orders.length;
        if (st.refundedTotal > 0n)
          lines.push({
            at, kind: "back", amount: (-st.refundedTotal).toString(), drop: p.address, link,
            title: winner ? `Paid back ${paid} ${winner} ${paid === 1 ? "fan" : "fans"}` : st.finalOutcome === "Draw" ? `Draw: a small thank you to ${paid} ${paid === 1 ? "buyer" : "buyers"}` : "Money returned to buyers",
            why: sources,
          });
        else
          lines.push({
            at, kind: "decision", amount: null, drop: p.address, link,
            title:
              st.buyers < st.minBuyers && st.finalOutcome !== "Void"
                ? `${match}: ${st.buyers} of ${st.minBuyers} buyers, so the offer stayed off and you kept every sale`
                : `${match}: ${winner ? `${winner} won` : st.finalOutcome === "Draw" ? "a draw" : "match voided"}, nothing owed back`,
            why: sources,
          });
      }
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
        byAgent: !!p.meta.byAgent,
        reconciled: held === st.reserve,
        extraSalesToBreakEven: p.meta.profitUsd && p.meta.profitUsd > 0 ? Math.ceil(Number(st.refundedTotal) / 1e6 / p.meta.profitUsd) : null,
      };
    }),
  );
  const sum = (k: "sales" | "held" | "refunded") => drops.reduce((t, d) => t + BigInt(d[k]), 0n);
  const sales = sum("sales"), held = sum("held"), refunded = sum("refunded");
  // The account's own history: what the agent opened by itself, what it asked for, and what it sent to the seller.
  const matchOf = (promo: Address) => {
    const d = mine.find((p) => p.address.toLowerCase() === promo.toLowerCase());
    return d ? `${shortTeam(d.meta.teamA)} v ${shortTeam(d.meta.teamB)}` : "a drop";
  };
  if (account) {
    const link = explorerAddr(account.address);
    for (const d of account.deals)
      if (d.byAgent) lines.push({ at: d.at, kind: "decision", amount: null, drop: d.promo, link, title: `Opened ${matchOf(d.promo)} by itself. The most it can cost is ${usd(BigInt(d.cap))}`, why: d.reason });
    for (const p of account.proposals)
      lines.push({
        at: p.at, kind: "asked", amount: null, link,
        title: `Asked you first: ${p.meta ? `${shortTeam(p.meta.teamA)} v ${shortTeam(p.meta.teamB)}` : "a drop"} for ${usd(BigInt(p.cap))}. ${p.status === "waiting" ? "Waiting for your answer" : p.status === "approved" ? "You said yes" : "You said no"}`,
        why: p.reason,
      });
    for (const p of account.payouts)
      lines.push({ at: p.at, kind: "out", amount: (-BigInt(p.amount)).toString(), link, title: `Sent to your wallet ${p.to.slice(0, 6)}…${p.to.slice(-4)}`, why: p.reason });
  }
  const inAccount = account ? BigInt(account.balance) : 0n;
  const paidOut = account ? BigInt(account.paidOut) : 0n;
  // Sales of drops opened from the seller's own wallet went straight to it at the sale.
  const ownWallet = mine.filter((p) => p.seller.toLowerCase() === seller.toLowerCase()).map((p) => p.address);
  const direct = drops.filter((d) => ownWallet.includes(d.address)).reduce((t, d) => t + BigInt(d.sales) - BigInt(d.held) - BigInt(d.refunded), 0n);
  const books: Books = {
    lines: lines.sort((a, b) => b.at - a.at).slice(0, 200),
    moneyIn: sales.toString(),
    paidBack: refunded.toString(),
    sentToSeller: (paidOut + (direct > 0n ? direct : 0n)).toString(),
    held: (held + inAccount).toString(),
    alone: (account?.deals.filter((d) => d.byAgent).length ?? 0) + settledCount + (account?.payouts.length ?? 0),
    asked: account?.proposals.length ?? 0,
    agreed: account?.proposals.filter((p) => p.status === "approved").length ?? 0,
    pairs: pairCount,
    settled: settledCount,
    due: dueCount,
  };
  return {
    name: mine[0]?.meta.shop ?? null,
    account,
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
    books,
  };
}
