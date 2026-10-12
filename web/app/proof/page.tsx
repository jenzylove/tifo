import { listPromos, promoJournal, promoOrders, promoState } from "@/lib/promos";
import { explorerAddr, NETWORK, usd } from "@/lib/chain";
import { shortTeam } from "@/lib/matches";

export const dynamic = "force-dynamic";

export default async function Proof() {
  const promos = await listPromos();
  const rows = await Promise.all(
    promos.map(async (p) => {
      const st = await promoState(p.address);
      const [orders, journal] = await Promise.all([promoOrders(p.address, st.ordersCount), promoJournal(p.address, st.journalCount)]);
      return { p, st, orders, journal };
    }),
  );
  const orders = rows.flatMap((r) => r.orders);
  const buyers = new Set(orders.map((o) => o.buyer.toLowerCase()));
  const sellers = new Set(promos.map((p) => p.seller.toLowerCase()));
  const volume = orders.reduce((t, o) => t + o.amount, 0n);
  const paidBack = rows.reduce((t, r) => t + r.st.refundedTotal, 0n);
  const decisions = rows.reduce((t, r) => t + r.journal.length, 0);
  return (
    <section className="wrap">
      <div className="pagehead">
        <span className="eyebrow">Read live from Arc {NETWORK}</span>
        <h1>Proof</h1>
        <p>Nothing on this page is typed in by hand. Every order, every decision the manager made and every refund links to the chain.</p>
      </div>
      <div className="stats">
        <div className="kpi"><span>Seller wallets and accounts</span><b>{sellers.size}</b></div>
        <div className="kpi"><span>Distinct fan wallets</span><b>{buyers.size}</b></div>
        <div className="kpi"><span>Paid in by fans</span><b>{usd(volume)}</b></div>
        <div className="kpi"><span>Refunded to winners</span><b>{usd(paidBack)}</b></div>
      </div>
      <p className="fine">{decisions} agent decisions recorded on chain across {promos.length} drops.</p>
      {rows.map(({ p, st, orders, journal }) => (
        <div key={p.address} className="proofrow panel">
          <h3>
            <a href={`/p/${p.address}`}>{shortTeam(p.meta.teamA)} v {shortTeam(p.meta.teamB)}</a> · {p.meta.shop} ·{" "}
            <a href={explorerAddr(p.address)} target="_blank" rel="noreferrer">contract on Arc</a>
          </h3>
          <p className="fine">
            Result: {st.finalOutcome === "None" ? (st.proposed === "None" ? "pending" : `proposed ${st.proposed}`) : st.finalOutcome} · {orders.length} orders · refunded{" "}
            {usd(st.refundedTotal)} · reserve {usd(st.reserve)} of {usd(st.cap)} cap
          </p>
          <ol>
            {orders.map((o, i) => (
              <li key={`o${i}`}>
                {new Date(o.at * 1000).toUTCString().slice(5, 22)} · fan <a href={explorerAddr(o.buyer)} target="_blank" rel="noreferrer">{o.buyer.slice(0, 8)}…</a> paid {usd(o.amount)} for{" "}
                {o.side === 0 ? shortTeam(p.meta.teamA) : shortTeam(p.meta.teamB)} at {o.rateBps / 100}%
              </li>
            ))}
            {journal.map((j, i) => (
              <li key={`j${i}`}>
                {new Date(j.at * 1000).toUTCString().slice(5, 22)} · agent · {j.kind}: {j.text}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}
