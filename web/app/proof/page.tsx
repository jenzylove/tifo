import { listPromos, promoActivity, promoState } from "@/lib/promos";
import { explorerAddr, explorerTx, NETWORK, usd } from "@/lib/chain";
import { shortTeam } from "@/lib/matches";

export const dynamic = "force-dynamic";

export default async function Proof() {
  const promos = await listPromos();
  const rows = await Promise.all(promos.map(async (p) => ({ p, st: await promoState(p.address), act: await promoActivity(p.address) })));
  const sales = rows.flatMap((r) => r.act.filter((a) => a.kind === "sale"));
  const refunds = rows.flatMap((r) => r.act.filter((a) => a.kind === "refund"));
  const buyers = new Set(sales.map((s) => s.buyer?.toLowerCase()));
  const sellers = new Set(promos.map((p) => p.seller.toLowerCase()));
  const volume = sales.reduce((t, s) => t + (s.amount ?? 0n), 0n);
  const paidBack = refunds.reduce((t, s) => t + (s.amount ?? 0n), 0n);
  return (
    <section className="page proof">
      <h1>Proof</h1>
      <p className="lede">Everything below is read live from Arc {NETWORK}. Nothing here is typed in by hand.</p>
      <div className="stats">
        <div><b>{sellers.size}</b> sellers</div>
        <div><b>{buyers.size}</b> distinct buyer wallets</div>
        <div><b>{usd(volume)}</b> paid in</div>
        <div><b>{usd(paidBack)}</b> refunded to fans</div>
      </div>
      {rows.map(({ p, st, act }) => (
        <div key={p.address} className="proofrow">
          <h3>
            <a href={`/p/${p.address}`}>{shortTeam(p.meta.teamA)} v {shortTeam(p.meta.teamB)}</a> · {p.meta.shop} ·{" "}
            <a href={explorerAddr(p.address)} target="_blank" rel="noreferrer">contract</a> · <a href={explorerTx(p.createdTx)} target="_blank" rel="noreferrer">created</a>
          </h3>
          <p className="fine">Final: {st.finalOutcome} · orders {st.ordersCount} · reserve {usd(st.reserve)} / cap {usd(st.cap)}</p>
          <ol className="activity">
            {act.map((a) => (
              <li key={a.tx + a.kind + (a.buyer ?? "")}>
                {a.kind === "sale"
                  ? `Sale ${usd(a.amount ?? 0n)} from ${a.buyer?.slice(0, 8)}… on side ${a.side === 0 ? "A" : "B"} at ${(a.rateBps ?? 0) / 100}% · held ${usd(a.held ?? 0n)} · to seller ${usd(a.toSeller ?? 0n)}`
                  : a.kind === "refund"
                    ? `Refund ${usd(a.amount ?? 0n)} to ${a.buyer?.slice(0, 8)}…`
                    : a.text}{" "}
                <a href={explorerTx(a.tx)} target="_blank" rel="noreferrer">tx</a>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}
