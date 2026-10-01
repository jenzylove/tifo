import { isAddress, type Address } from "viem";
import { notFound } from "next/navigation";
import AutoRefresh from "@/components/AutoRefresh";
import Checkout, { WalletBar } from "@/components/Checkout";
import { explorerAddr, explorerTx, usd } from "@/lib/chain";
import { listPromos, promoActivity, promoState } from "@/lib/promos";
import { shortTeam } from "@/lib/matches";

export const dynamic = "force-dynamic";

export default async function PromoPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!isAddress(address)) notFound();
  const p = (await listPromos()).find((x) => x.address.toLowerCase() === address.toLowerCase());
  if (!p) notFound();
  const [st, activity] = await Promise.all([promoState(p.address as Address), promoActivity(p.address as Address)]);
  const sales = activity.filter((a) => a.kind === "sale");
  const fans = [0, 1].map((s) => sales.filter((x) => x.side === s));
  const total = [0, 1].map((s) => fans[s].reduce((t, x) => t + (x.amount ?? 0n), 0n));
  const sum = Number(total[0] + total[1]) || 1;
  const closed = Date.now() / 1000 >= st.closesAt;
  const A = shortTeam(p.meta.teamA), B = shortTeam(p.meta.teamB);
  const refunds = activity.filter((a) => a.kind === "refund");
  const winner = st.finalOutcome === "A" ? A : st.finalOutcome === "B" ? B : null;

  return (
    <section className="page promo">
      <AutoRefresh />
      <p className="kicker">{p.meta.league} · {new Date(p.meta.kickoff).toUTCString().slice(0, 22)} UTC</p>
      <h1 className="fixture">
        <span>{A}</span> <em>v</em> <span>{B}</span>
      </h1>
      <p className="lede">
        {p.meta.shop} · {p.meta.product} · ${p.meta.priceUsd}
        {p.meta.link && <> · <a href={p.meta.link} target="_blank" rel="noreferrer">shop</a></>}
      </p>

      {st.finalOutcome !== "None" ? (
        <div className="result">
          {winner ? (
            <h2>{winner} won. {refunds.length} {winner} fans got {usd(refunds.reduce((t, r) => t + (r.amount ?? 0n), 0n))} back.</h2>
          ) : (
            <h2>{st.finalOutcome === "Draw" ? "Draw. No rebates this time." : "Match voided. No rebates."}</h2>
          )}
        </div>
      ) : st.proposed !== "None" ? (
        <div className="result"><h2>Result in: {st.proposed === "A" ? A : st.proposed === "B" ? B : st.proposed}. Refunds go out at {new Date((st.proposedAt + 900) * 1000).toUTCString().slice(17, 22)} UTC.</h2></div>
      ) : null}

      {!closed && st.finalOutcome === "None" && <WalletBar priceUsd={p.meta.priceUsd} />}

      <div className="sides">
        {[0, 1].map((s) => (
          <div key={s} className={`side side-${s}`}>
            <h3>{s === 0 ? A : B} fans</h3>
            <div className="offer"><b>{st.rates[s] / 100}%</b> back if {s === 0 ? A : B} win</div>
            <div className="meter"><i style={{ width: `${(Number(total[s]) / sum) * 100}%` }} /></div>
            <p className="fine">{fans[s].length} fans · {usd(total[s])} · owed if they win: {usd(st.liability[s])}</p>
            <Checkout promo={p.address} side={s as 0 | 1} team={s === 0 ? A : B} rateBps={st.rates[s]} priceUsd={p.meta.priceUsd} product={p.meta.product} closed={closed} />
          </div>
        ))}
      </div>

      <div className="book">
        <p>Held for refunds: <b>{usd(st.reserve)}</b> of the seller&apos;s {usd(st.cap)} cap. Everything else already went to the seller. A draw pays no rebate.</p>
        <p className="fine">Contract <a href={explorerAddr(p.address)} target="_blank" rel="noreferrer">{p.address.slice(0, 10)}…</a></p>
      </div>

      <h2>What the agent did</h2>
      <ol className="activity">
        {activity.filter((a) => a.kind !== "sale").reverse().map((a) => (
          <li key={a.tx + a.text}>
            {a.kind === "refund" ? `Refunded ${usd(a.amount ?? 0n)} to ${a.buyer?.slice(0, 8)}…` : a.text}{" "}
            <a href={explorerTx(a.tx)} target="_blank" rel="noreferrer">tx</a>
          </li>
        ))}
        {sales.length > 0 && <li>{sales.length} purchases so far, each one on chain.</li>}
      </ol>
    </section>
  );
}
