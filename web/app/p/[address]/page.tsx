import type { Metadata } from "next";
import { isAddress, type Address } from "viem";
import { notFound } from "next/navigation";
import AutoRefresh from "@/components/AutoRefresh";
import Checkout, { WalletBar } from "@/components/Checkout";
import Countdown from "@/components/Countdown";
import { explorerAddr, usd } from "@/lib/chain";
import { listPromos, promoJournal, promoOrders, promoState } from "@/lib/promos";
import { shortTeam } from "@/lib/matches";
import { inkOn, teamColors } from "@/lib/teams";

export const dynamic = "force-dynamic";

async function load(address: string) {
  if (!isAddress(address)) return null;
  const p = (await listPromos()).find((x) => x.address.toLowerCase() === address.toLowerCase());
  if (!p) return null;
  const st = await promoState(p.address as Address);
  const [orders, journal] = await Promise.all([promoOrders(p.address, st.ordersCount), promoJournal(p.address, st.journalCount)]);
  return { p, st, orders, journal };
}

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params;
  const d = await load(address);
  if (!d) return { title: "Tifo" };
  const A = shortTeam(d.p.meta.teamA), B = shortTeam(d.p.meta.teamB);
  return {
    title: `${A} v ${B} · ${d.p.meta.shop} · Tifo`,
    description: `${A} fans get ${d.st.rates[0] / 100}% back if ${A} win. ${B} fans get ${d.st.rates[1] / 100}% back if ${B} win. ${d.p.meta.product}, $${d.p.meta.priceUsd}.`,
  };
}

const TILE_SLOTS = 48;

export default async function PromoPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const d = await load(address);
  if (!d) notFound();
  const { p, st, orders, journal } = d;
  const A = shortTeam(p.meta.teamA), B = shortTeam(p.meta.teamB);
  const [ca, cb] = teamColors(p.meta.teamA, p.meta.teamB);
  const team = [A, B];
  const closed = Date.now() / 1000 >= st.closesAt;
  const decided = st.finalOutcome !== "None" ? st.finalOutcome : st.proposed;
  const winner = decided === "A" ? 0 : decided === "B" ? 1 : null;
  const settled = st.finalOutcome !== "None";
  const fans = [0, 1].map((s) => orders.filter((o) => o.side === s));
  const raised = [0, 1].map((s) => fans[s].reduce((t, o) => t + o.amount, 0n));
  const owedIfWin = [0, 1].map((s) => fans[s].reduce((t, o) => t + o.refund, 0n));
  const phase = settled ? "settled" : st.proposed !== "None" ? "result" : closed ? "live" : "open";

  return (
    <div className={`drop phase-${phase}`} style={{ ["--ca" as string]: ca, ["--cb" as string]: cb, ["--ia" as string]: inkOn(ca), ["--ib" as string]: inkOn(cb) }}>
      <AutoRefresh />
      <div className="drop-top">
        <span>{p.meta.league}</span>
        <span>
          {phase === "open" ? (
            <>
              Kickoff in <Countdown to={st.closesAt * 1000} />
            </>
          ) : phase === "live" ? (
            "Match in progress · orders closed"
          ) : phase === "result" ? (
            "Result in · refunds after a 15-minute check"
          ) : (
            "Full time"
          )}
        </span>
      </div>

      <section className="banner">
        {[0, 1].map((s) => (
          <div key={s} className={`half half-${s} ${winner === s ? "won" : winner !== null ? "lost" : ""}`}>
            <h1 className="team">{team[s]}</h1>
            <div className="offer">
              <b>{st.rates[s] / 100}%</b>
              <span>back if {team[s]} win</span>
            </div>
            <div className="tifo" aria-label={`${fans[s].length} ${team[s]} fans in`}>
              {Array.from({ length: Math.max(TILE_SLOTS, fans[s].length) }).map((_, i) => {
                const o = fans[s][i];
                return (
                  <i key={i} className={o ? "in" : ""} title={o ? `${o.buyer.slice(0, 6)}… · ${usd(o.amount)}` : ""}>
                    {o && winner === s && settled ? <em>+{usd(o.refund)}</em> : null}
                  </i>
                );
              })}
            </div>
            <p className="count">
              <b>{fans[s].length}</b> {team[s]} {fans[s].length === 1 ? "fan" : "fans"} in · {usd(raised[s])}
            </p>
            {phase === "open" && (
              <Checkout promo={p.address} side={s as 0 | 1} team={team[s]} rateBps={st.rates[s]} priceUsd={p.meta.priceUsd} product={p.meta.product} closed={closed} />
            )}
          </div>
        ))}
        <div className="versus">v</div>
      </section>

      {settled && (
        <section className="reveal">
          {winner !== null ? (
            <h2>
              {team[winner]} won. {fans[winner].length} {team[winner]} {fans[winner].length === 1 ? "fan" : "fans"} got <b>{usd(st.refundedTotal)}</b> back.
            </h2>
          ) : (
            <h2>{st.finalOutcome === "Draw" ? "A draw. No rebates this time." : "Match voided. No rebates, and the reserve went back to the shop."}</h2>
          )}
        </section>
      )}

      <section className="product">
        {p.meta.image ? <img src={p.meta.image} alt={p.meta.product} /> : <div className="noimg">{p.meta.product.slice(0, 1)}</div>}
        <div>
          <p className="kicker">{p.meta.shop}</p>
          <h2>{p.meta.product}</h2>
          <p className="price">${p.meta.priceUsd.toFixed(2)} · full price, delivered by the shop as usual</p>
          {p.meta.link && (
            <a href={p.meta.link} target="_blank" rel="noreferrer" className="ghost">
              See the shop
            </a>
          )}
        </div>
      </section>

      {phase === "open" && <WalletBar priceUsd={p.meta.priceUsd} />}

      <section className="how">
        <div>
          <b>1</b> Pick your team and buy at full price.
        </div>
        <div>
          <b>2</b> Your % is locked the moment you buy.
        </div>
        <div>
          <b>3</b> If your team wins, the rebate lands in your wallet after full time. A draw pays no rebate.
        </div>
      </section>

      <section className="ledger">
        <h3>The shop&apos;s book</h3>
        <p>
          Owed if {A} win: <b>{usd(owedIfWin[0])}</b> · owed if {B} win: <b>{usd(owedIfWin[1])}</b> · held for refunds: <b>{usd(st.reserve)}</b> of a{" "}
          {usd(st.cap)} cap. Everything else went to the shop the moment each order landed.
        </p>
        <h3>What the agent decided</h3>
        <ol className="journal">
          {journal.length === 0 && <li>No changes yet. Offers move when one side runs ahead.</li>}
          {journal
            .slice()
            .reverse()
            .map((j, i) => (
              <li key={i}>
                <time>{new Date(j.at * 1000).toUTCString().slice(5, 22)}</time> {label(j.kind, j.text, A, B)}
              </li>
            ))}
        </ol>
        <p className="fine">
          Every number here is read from the promo contract on Arc:{" "}
          <a href={explorerAddr(p.address)} target="_blank" rel="noreferrer">
            {p.address}
          </a>
        </p>
      </section>
    </div>
  );
}

function label(kind: string, text: string, A: string, B: string) {
  const out = (o: string) => (o === "A" ? `${A} won` : o === "B" ? `${B} won` : o === "Draw" ? "draw" : o === "Void" ? "voided" : o);
  switch (kind) {
    case "rates":
      return `Moved the offers. ${text}`;
    case "result":
      return `Checked the result. ${text}`;
    case "proposed":
      return `Proposed the result: ${out(text)}. Final after a 15-minute challenge window.`;
    case "corrected":
      return `Operator corrected the result: ${out(text)}.`;
    case "final":
      return `Result final: ${out(text)}. Refunds sent.`;
    case "remainder":
      return "Returned the unused reserve to the shop.";
    default:
      return `${kind}: ${text}`;
  }
}
