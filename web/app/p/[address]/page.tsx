import type { Metadata } from "next";
import { isAddress, type Address } from "viem";
import { notFound } from "next/navigation";
import { after } from "next/server";
import AutoRefresh from "@/components/AutoRefresh";
import Checkout from "@/components/Checkout";
import Countdown from "@/components/Countdown";
import Purchase from "@/components/Purchase";
import DeliveryPanel from "@/components/DeliveryPanel";
import { readDeliveries } from "@/lib/shipments";
import { settleNow } from "@/lib/agent";
import { explorerAddr, usd } from "@/lib/chain";
import { listPromos, promoJournal, promoOrders, promoState } from "@/lib/promos";
import { coverLeft, lastFew, tierLabel } from "@/lib/offer";
import { offerLabel } from "@/lib/precheck";
import { bookedSlots } from "@/lib/booking";
import { shortTeam } from "@/lib/matches";
import { teamColors } from "@/lib/teams";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function load(address: string) {
  if (!isAddress(address)) return null;
  const p = (await listPromos()).find((x) => x.address.toLowerCase() === address.toLowerCase());
  if (!p) return null;
  const st = await promoState(p.address as Address);
  const [orders, journal, booked, deliveries] = await Promise.all([
    promoOrders(p.address, st.ordersCount),
    promoJournal(p.address, st.journalCount),
    p.meta.slots?.length ? bookedSlots(p.address as Address, p.meta.slots.length).catch(() => p.meta.slots!.map(() => false)) : Promise.resolve([] as boolean[]),
    p.meta.delivery || p.meta.slots?.length ? Promise.resolve(null) : readDeliveries(p.address as Address, st.ordersCount),
  ]);
  return { p, st, orders, journal, booked, deliveries };
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
  const { p, st, orders, journal, booked, deliveries } = d;
  const A = shortTeam(p.meta.teamA), B = shortTeam(p.meta.teamB);
  const team: [string, string] = [A, B];
  const colors = teamColors(p.meta.teamA, p.meta.teamB) as [string, string];
  const closed = Date.now() / 1000 >= st.closesAt;
  const decided = st.finalOutcome !== "None" ? st.finalOutcome : st.proposed;
  const winner = decided === "A" ? 0 : decided === "B" ? 1 : null;
  const settled = st.finalOutcome !== "None";
  const fans = [0, 1].map((s) => orders.filter((o) => o.side === s));
  const owedIfWin = [0, 1].map((s) => fans[s].reduce((t, o) => t + o.refund, 0n));
  const paidFans = winner === null ? 0 : new Set(fans[winner].filter((o) => o.refund > 0n).map((o) => o.buyer.toLowerCase())).size;
  const phase = settled ? "settled" : st.proposed !== "None" ? "result" : closed ? "live" : "open";
  const shopName = p.meta.shop;
  const description = p.meta.description;
  const image = p.meta.image;
  const digital = !!p.meta.delivery;
  const free = Math.max(...st.rates) >= 10_000;
  // How many more buyers each side's budget covers at its offer. Shown to buyers only when nearly gone.
  const priceUnits = BigInt(Math.round(p.meta.priceUsd * 1e6));
  // With a stock count, what is left is the stock minus everything sold, whichever side bought it.
  const sold = priceUnits > 0n ? Number(orders.reduce((t, o) => t + o.amount, 0n) / priceUnits) : 0;
  const stockLeft = p.meta.stock ? Math.max(0, p.meta.stock - sold) : null;
  const spots = [0, 1].map((s) => (stockLeft !== null ? stockLeft : coverLeft(st.cap, st.liability[s], priceUnits, st.rates[s])));
  const share = Math.max(...st.rates);
  const drawLine = st.drawBps > 0 ? `If the match is a draw, every buyer gets a small thank you (${st.drawBps / 100}% of what they paid).` : "A draw pays nothing back.";
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
                {paidFans > 0 ? (
                  <>
                    {team[winner]} won. {paidFans} {team[winner]} {paidFans === 1 ? "fan" : "fans"} got <b>{usd(st.refundedTotal)}</b> back.
                  </>
                ) : (
                  <>{team[winner]} won. No {team[winner]} fans had bought, so nothing was owed back.</>
                )}
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
                {p.meta.league} · {kick.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}
              </span>
            </span>
            {phase === "open" ? (
              <span style={{ textAlign: "right" }}>
                Sale ends in
                <br />
                <Countdown to={st.closesAt * 1000} />
              </span>
            ) : phase === "live" ? (
              <span className="pill live">Sale ended</span>
            ) : phase === "result" ? (
              <span>Result in, final check</span>
            ) : (
              <span>Full time</span>
            )}
          </div>
        </div>

        <div className="info">
          <span className="pill ac" style={{ justifySelf: "start" }}>{free ? "Free if your team wins" : `${share / 100}% back if your team wins`}</span>
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
              spots={spots as [number | null, number | null]}
              priceUsd={p.meta.priceUsd}
              product={p.meta.product}
              shop={shopName}
              closed={closed}
              digital={digital}
              contact={p.meta.contact}
              slots={p.meta.slots?.map((t, i) => ({ i, at: t, taken: booked[i] ?? false }))}
              reach={st.minBuyers > 1 ? { need: st.minBuyers, have: st.buyers } : null}
              moving={p.meta.minBps < p.meta.maxBps}
              lastMove={[...journal].reverse().find((j) => j.kind === "rates")?.text}
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
              <p className="fine">The sale has ended. {phase === "result" ? "Refunds go out after a 15-minute check." : ""}</p>
            </div>
          )}
          {digital && <Purchase promo={p.address} product={p.meta.product} />}
          {deliveries && (
            <DeliveryPanel
              promo={p.address}
              seller={p.seller}
              holdSecs={deliveries.holdSecs}
              shop={shopName}
              rows={orders.map((o, i) => ({
                i,
                buyer: o.buyer,
                amount: usd(o.amount),
                at: o.at,
                state: deliveries.list[i]?.state ?? "None",
                sentAt: deliveries.list[i]?.sentAt ?? 0,
                tracking: deliveries.list[i]?.tracking ?? "",
              }))}
            />
          )}
        </div>
      </div>

      {orders.length > 0 && (
      <section className="terrace">
        <h2 className="h">
          Who is in so far <small>each mark is an order</small>
        </h2>
        <div className="stands">
          {[0, 1].map((s) => (
            <div key={s} className={`stand ${winner === s ? "won" : winner !== null ? "lost" : ""}`} style={{ ["--c" as string]: colors[s] }}>
              <header>
                <b>{team[s]}</b>
                <span>
                  {fans[s].length} {fans[s].length === 1 ? "order" : "orders"}
                  {phase === "open"
                    ? ` · ${lastFew(spots[s]) ?? (spots[s] === 0 ? "offer used up" : tierLabel(st.rates[s]).toLowerCase() + " if they win")}`
                    : fans[s].length > 0 && ` · ${tierLabel(Math.max(...fans[s].map((o) => o.rateBps), 0)).toLowerCase()} if they win`}
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

      )}

      <div className="how">
        <details>
          <summary>How this works</summary>
          <p>
            You pay the normal price and pick the team you think will win. {free ? "If your team wins, the whole price comes back to your wallet." : `If your team wins, ${share / 100}% of the price comes back to your wallet.`} The offer runs while the shop's budget lasts, and you see exactly what you get before you pay.{" "}
            {digital ? "Your purchase opens on this page as soon as you pay." : p.meta.slots?.length ? `You pick a time when you pay, then message ${shopName} on WhatsApp with anything they need before it.` : deliveries ? `${shopName} delivers it, and your payment waits in this drop until you confirm you have it.` : `${shopName} delivers as usual.`} You keep what you bought whatever happens.
          </p>
        </details>
        <details>
          <summary>When do I get my money back?</summary>
          <p>After full time, once two of three result sources agree and a 15 minute check has passed. It lands in your wallet by itself. {drawLine}</p>
        </details>
        <details>
          <summary>The numbers behind this drop</summary>
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
