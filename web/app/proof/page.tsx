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
    <section className="page proof">
      <h1>Proof</h1>
      <p className="lede">Read live from the contracts on Arc {NETWORK}. Nothing on this page is typed in by hand, and every line links to the chain.</p>
      <div className="stats">
        <div><b>{sellers.size}</b> shops</div>
        <div><b>{buyers.size}</b> distinct fan wallets</div>
        <div><b>{usd(volume)}</b> paid in by fans</div>
        <div><b>{usd(paidBack)}</b> refunded to winners</div>
      </div>
      <p className="fine">{decisions} agent decisions recorded on chain across {promos.length} drops.</p>
      {rows.map(({ p, st, orders, journal }) => (
        <div key={p.address} className="proofrow">
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
