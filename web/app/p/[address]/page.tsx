import type { Metadata } from "next";
import { isAddress, type Address } from "viem";
import { notFound } from "next/navigation";
import { after } from "next/server";
import AutoRefresh from "@/components/AutoRefresh";
import Checkout from "@/components/Checkout";
import Countdown from "@/components/Countdown";
import Purchase from "@/components/Purchase";
import { settleNow } from "@/lib/agent";
import { explorerAddr, usd } from "@/lib/chain";
import { listPromos, promoJournal, promoOrders, promoState } from "@/lib/promos";
import { offerLabel } from "@/lib/precheck";
import { shortTeam } from "@/lib/matches";
import { teamColors } from "@/lib/teams";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    title: `${d.p.meta.product} · ${A} v ${B} drop · ${d.p.meta.shop}`,
    description: `${d.p.meta.product}, $${d.p.meta.priceUsd}. ${offerLabel(d.st.rates[0], A)}. ${offerLabel(d.st.rates[1], B)}.`,
  };
}

const TILE_SLOTS = 36;

export default async function DropPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const d = await load(address);
  if (!d) notFound();
  const { p, st, orders, journal } = d;
  const A = shortTeam(p.meta.teamA), B = shortTeam(p.meta.teamB);
  const team: [string, string] = [A, B];
  const colors = teamColors(p.meta.teamA, p.meta.teamB) as [string, string];
  const closed = Date.now() / 1000 >= st.closesAt;
  const decided = st.finalOutcome !== "None" ? st.finalOutcome : st.proposed;
  const winner = decided === "A" ? 0 : decided === "B" ? 1 : null;
  const settled = st.finalOutcome !== "None";
  const fans = [0, 1].map((s) => orders.filter((o) => o.side === s));
  const owedIfWin = [0, 1].map((s) => fans[s].reduce((t, o) => t + o.refund, 0n));
  const phase = settled ? "settled" : st.proposed !== "None" ? "result" : closed ? "live" : "open";
  const shopName = p.meta.shop;
  const description = p.meta.description;
  const image = p.meta.image;
  const digital = !!p.meta.delivery;
  const free = Math.max(...st.rates) >= 10_000;
  // Free spots left on each side: what is left of the budget, in whole products.
  const priceUnits = BigInt(Math.round(p.meta.priceUsd * 1e6));
  const spots = [0, 1].map((s) => (free && priceUnits > 0n ? Number((st.cap > st.liability[s] ? st.cap - st.liability[s] : 0n) / priceUnits) : null));
  const drawLine = st.drawBps > 0 ? `On a draw every buyer gets ${st.drawBps / 100}% back as a thank you.` : "A draw pays no rebate.";
  const kick = new Date(p.meta.kickoff);
  // Once the match is over, anyone watching this page moves the settlement along: result, final check, refunds.
  const fullTime = Date.now() / 1000 >= st.settleNotBefore || st.proposed !== "None";
  if (fullTime && !(settled && st.remainderReleased)) after(() => settleNow(p).then(() => undefined));

  const feed = [
    ...orders.map((o) => ({ at: o.at, sale: true, text: `${team[o.side]} fan bought for ${usd(o.amount)} at ${o.rateBps / 100}% back` })),
    ...journal.map((j) => ({ at: j.at, sale: false, text: label(j.kind, j.text, A, B) })),
  ].sort((a, b) => b.at - a.at);

  return (
    <div className="wrap" style={{ ["--ca" as string]: colors[0], ["--cb" as string]: colors[1] }}>
      {phase !== "settled" && <AutoRefresh />}

      {settled && (
        <section className="reveal" style={{ ["--win" as string]: winner !== null ? colors[winner] : undefined }}>
          <h2>
            {winner !== null ? (
              <>
                {team[winner]} won. {fans[winner].length} {team[winner]} {fans[winner].length === 1 ? "fan" : "fans"} got <b>{usd(st.refundedTotal)}</b> back.
              </>
            ) : st.finalOutcome === "Draw" ? (
              st.refundedTotal > 0n ? `A draw. Every buyer got a thank you: ${usd(st.refundedTotal)} back in total.` : "A draw. No rebates this time."
            ) : (
              "Match voided. No rebates, and the set-aside went back to the shop."
            )}
          </h2>
        </section>
      )}

      <div className="crumb">
        <span className="mini-logo">{shopName.slice(0, 1)}</span>
        <b>{shopName}</b>
      </div>

      <div className="pdp">
        <div className="gallery">
          {image ? <img src={image} alt={p.meta.product} /> : <div className="noimg"><span className="ph-name">{p.meta.product}</span></div>}
          <div className="ribbon">
            <span>
              <b>
                {A} v {B}
              </b>
              <br />
              <span style={{ opacity: 0.8 }}>
                {p.meta.league} · {kick.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC
              </span>
            </span>
            {phase === "open" ? (
              <span style={{ textAlign: "right" }}>
                Kicks off in
                <br />
                <Countdown to={st.closesAt * 1000} />
              </span>
            ) : phase === "live" ? (
              <span className="pill live">Match on</span>
            ) : phase === "result" ? (
              <span>Result in, final check</span>
            ) : (
              <span>Full time</span>
            )}
          </div>
        </div>

        <div className="info">
          <span className="eyebrow">Matchday promo · {free ? "free if your team wins" : `up to ${Math.max(...st.rates) / 100}% back`}</span>
          <h1>{p.meta.product}</h1>
          <div className="price">${p.meta.priceUsd.toFixed(2)}</div>
          {description && <p className="desc">{description}</p>}
          <div className="scarf" style={{ margin: "20px 0 0", maxWidth: 160 }} />
          {phase === "open" ? (
            <Checkout
              promo={p.address}
              teams={team}
              colors={colors}
              rates={st.rates}
              liability={[st.liability[0].toString(), st.liability[1].toString()]}
              cap={st.cap.toString()}
              floorBps={st.floorBps}
              drawBps={st.drawBps}
              priceUsd={p.meta.priceUsd}
              product={p.meta.product}
              shop={shopName}
              closed={closed}
              digital={digital}
              contact={p.meta.contact}
            />
          ) : (
            <div className="buybox">
              <div className="sides">
                {[0, 1].map((s) => (
                  <div key={s} className={`side ${winner === s ? "on" : ""}`} style={{ ["--c" as string]: colors[s] }}>
                    <span className="t">{team[s]}</span>
                    <span className="pct">{st.rates[s] >= 10_000 ? "Free" : `${st.rates[s] / 100}%`}</span>
                    <span className="back">{fans[s].length} {fans[s].length === 1 ? "order" : "orders"}</span>
                  </div>
                ))}
              </div>
              <p className="fine">Orders closed at kickoff. {phase === "result" ? "Refunds go out after a 15-minute check." : ""}</p>
            </div>
          )}
          {digital && <Purchase promo={p.address} product={p.meta.product} />}
        </div>
      </div>

      <section className="terrace">
        <h2 className="h">
          Promo so far <small>each tile is an order</small>
        </h2>
        <div className="stands">
          {[0, 1].map((s) => (
            <div key={s} className={`stand ${winner === s ? "won" : winner !== null ? "lost" : ""}`} style={{ ["--c" as string]: colors[s] }}>
              <header>
                <b>{team[s]}</b>
                <span>
                  {fans[s].length} {fans[s].length === 1 ? "order" : "orders"} ·{" "}
                  {spots[s] !== null ? (phase === "open" ? `${spots[s]} free ${spots[s] === 1 ? "spot" : "spots"} left` : "free if they win") : `${st.rates[s] / 100}% back now`}
                </span>
              </header>
              <div className="tifo">
                {Array.from({ length: Math.max(TILE_SLOTS, fans[s].length) }).map((_, i) => {
                  const o = fans[s][i];
                  return (
                    <i key={i} className={o ? "in" : ""} title={o ? `${usd(o.amount)} at ${o.rateBps / 100}%` : ""}>
                      {o && winner === s && settled ? <em>+{usd(o.refund)}</em> : null}
                    </i>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 40 }}>
        <div className="steps3">
          <div>
            <b>1</b>
            <h4>Buy at full price</h4>
            <p>Choose which result your discount rides on. Your % is locked the moment you buy. {digital ? "Your purchase opens on this page as soon as you pay." : `${shopName} delivers as usual.`}</p>
          </div>
          <div>
            <b>2</b>
            <h4>Bigger % on the underdog</h4>
            <p>Offers come from live odds, so every fan gets the same expected discount. They shift as one side fills up.</p>
          </div>
          <div>
            <b>3</b>
            <h4>Money back after full time</h4>
            <p>When two of three result sources agree, winning fans are refunded in USDC. {drawLine}</p>
          </div>
        </div>
      </section>

      <details className="behind">
        <summary>Behind this drop: the shop&apos;s book and every decision</summary>
        <div className="cols">
          <div>
            <h4>The book</h4>
            <div className="mini-row">
              <span>Owed if {A} win</span>
              <b>{usd(owedIfWin[0])}</b>
            </div>
            <div className="mini-row">
              <span>Owed if {B} win</span>
              <b>{usd(owedIfWin[1])}</b>
            </div>
            <div className="mini-row">
              <span>Set aside for refunds</span>
              <b>{usd(st.reserve)}</b>
            </div>
            <div className="mini-row">
              <span>Most the shop can owe</span>
              <b>{usd(st.cap)}</b>
            </div>
            {settled && (
              <div className="mini-row">
                <span>Refunded to fans</span>
                <b>{usd(st.refundedTotal)}</b>
              </div>
            )}
            <p className="fine" style={{ marginTop: 10 }}>
              Everything else went to the shop the moment each order landed. Read live from the{" "}
              <a href={explorerAddr(p.address)} target="_blank" rel="noreferrer">
                drop contract on Arc
              </a>
              .
            </p>
          </div>
          <div>
            <h4>Timeline</h4>
            <ul className="timeline">
              {feed.length === 0 && <li>No orders yet. The manager moves the offers when one side runs ahead.</li>}
              {feed.slice(0, 30).map((f, i) => (
                <li key={i} className={f.sale ? "sale" : ""}>
                  <span>
                    <time>{new Date(f.at * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC</time>
                    {f.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </div>
  );
}

function label(kind: string, text: string, A: string, B: string) {
  const out = (o: string) => (o === "A" ? `${A} won` : o === "B" ? `${B} won` : o === "Draw" ? "draw" : o === "Void" ? "voided" : o);
  switch (kind) {
    case "opened":
      return `Manager opened this drop. ${text}`;
    case "rates":
      return `Manager moved the offers. ${text}`;
    case "result":
      return `Manager checked the result. ${text}`;
    case "proposed":
      return `Result in: ${out(text)}. Final after a 15-minute check.`;
    case "corrected":
      return `Result corrected: ${out(text)}.`;
    case "final":
      return `Result final: ${out(text)}. Refunds sent.`;
    case "remainder":
      return "Returned the unused set-aside to the shop.";
    default:
      return `${kind}: ${text}`;
  }
}
