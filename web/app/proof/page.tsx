import { isCheckDrop, listPromos, promoJournal, promoOrders, promoState } from "@/lib/promos";
import { explorerAddr, NETWORK, usd } from "@/lib/chain";
import { shortTeam } from "@/lib/matches";
import { agentRecord } from "@/lib/record";

export const dynamic = "force-dynamic";

export default async function Proof() {
  const everything = await listPromos();
  // Our own system checks are listed at the bottom and left out of every number on this page.
  const promos = everything.filter((p) => !isCheckDrop(p.meta));
  const checks = everything.filter((p) => isCheckDrop(p.meta));
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
  const record = await agentRecord(rows.map((r) => ({ p: r.p, st: r.st, volume: r.orders.reduce((t, o) => t + o.amount, 0n) })));
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
      <h3 className="proof-h">What the agent did with the money</h3>
      <div className="stats">
        <div className="kpi"><span>Businesses it runs</span><b>{record.businesses}</b></div>
        <div className="kpi"><span>Sent on to sellers</span><b>{usd(record.sentToSellers)}</b></div>
        <div className="kpi"><span>Results paid with nobody clicking</span><b>{record.settled} of {record.due}</b></div>
        <div className="kpi"><span>Did by itself</span><b>{record.alone}</b></div>
        <div className="kpi"><span>Asked the seller first</span><b>{record.asked}{record.asked > 0 ? `, ${record.agreed} approved` : ""}</b></div>
      </div>
      <p className="fine">
        A business is a seller with an account on Arc that holds their rule: how much the agent&apos;s drops may cost in a week. Inside it the agent acts alone;
        over it, it can only ask. {decisions} agent decisions are written on chain across {promos.length} drops.
      </p>
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
                {new Date(j.at * 1000).toUTCString().slice(5, 22)} · agent · {j.text ? `${j.kind}: ${j.text}` : j.kind === "remainder" ? "the rest went back to the seller" : j.kind}
              </li>
            ))}
          </ol>
        </div>
      ))}
      {checks.length > 0 && (
        <details className="ask" style={{ marginTop: 24 }}>
          <summary>
            {checks.length} system {checks.length === 1 ? "check" : "checks"} we ran ourselves, not counted above
          </summary>
          <ol>
            {checks.map((p) => (
              <li key={p.address}>
                {shortTeam(p.meta.teamA)} v {shortTeam(p.meta.teamB)} · {p.meta.product} ·{" "}
                <a href={explorerAddr(p.address)} target="_blank" rel="noreferrer">contract on Arc</a>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
