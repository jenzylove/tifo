import type { CSSProperties } from "react";
import Duties from "@/components/Duties";
import Reveal from "@/components/Reveal";
import { dropCards } from "@/lib/board";
import { usd } from "@/lib/chain";
import { shortTeam } from "@/lib/matches";
import { offerLabel } from "@/lib/precheck";
import { promoState } from "@/lib/promos";
import { teamColors } from "@/lib/teams";

export const dynamic = "force-dynamic";

const HEAD = ["Turn", "any", "big", "match", "into"];
const i = (n: number) => ({ ["--i" as string]: n }) as CSSProperties;

export default async function Landing() {
  const cards = await dropCards(undefined, 24).catch(() => []);
  // The three product cards show an example seller so the idea reads at a glance. The announcement and the strip
  // of numbers under them are read from the chain and nothing else.
  const freeDrops = cards.filter((c) => c.p.meta.shape === "free");
  const live = freeDrops.find((c) => c.phase === "open") ?? freeDrops[0] ?? cards[0];
  const paid = cards.find((c) => c.phase === "settled" && c.note?.includes("paid back"));
  const paidState = paid ? await promoState(paid.p.address).catch(() => null) : null;
  const settled = cards.filter((c) => c.phase === "settled").length;
  const orders = cards.reduce((t, c) => t + c.fans, 0);
  const byAgent = cards.filter((c) => c.p.meta.byAgent).length;
  const A = live ? shortTeam(live.p.meta.teamA) : "Arsenal";
  const B = live ? shortTeam(live.p.meta.teamB) : "Chelsea";
  const [ca, cb] = live ? teamColors(live.p.meta.teamA, live.p.meta.teamB) : ["#d92b3a", "#2b5fd9"];
  // The example on the cards: 10 t-shirts at $20, 25% back for every buyer, so the most it can cost is $50.
  const rates = [2_500, 2_500];
  const product = "Team t-shirt";
  const price = 20;
  const stock = 10;
  const budget = (stock * price * rates[0]) / 10_000;
  const bigEnough = paidState && paidState.refundedTotal >= 5_000_000n;

  return (
    <>
      <section className="hero wrap">
        <a className="news" href="/proof">
          <b>Live</b>
          {paidState && bigEnough ? (
            <span>
              The last winners got <strong>{usd(paidState.refundedTotal)}</strong> back<em>. See the proof</em>
            </span>
          ) : (
            <span>
              Every drop and payout is on Arc<em>. See the proof</em>
            </span>
          )}
        </a>
        <p className="eyebrow agent-eyebrow">
          <span className="orb sm" /> An AI agent for your shop
        </p>
        <h1 className="mega">
          {HEAD.map((w, n) => (
            <span key={w}>
              <span className="w" style={i(n)}>
                {w}
              </span>{" "}
            </span>
          ))}
          <span className="hl" style={i(HEAD.length)}>
            sales
            <span className="sticker">money back if your team wins</span>
          </span>
        </h1>
        <p className="sub">
          Its first job is bringing you sales on match days: it plans a promo around a big game, pays winning fans back and sends you the rest. It also
          keeps your books, pays you after every sale and collects delivery addresses, and it only spends inside the limit you set.
        </p>
        <div className="ctas">
          <a className="btn ac" href="/manage?new=1">
            Make a drop
          </a>
          <a className="btn ghost" href={live ? `/p/${live.p.address}` : "/drops"}>
            See a live one
          </a>
        </div>
      </section>

      <div className="trio">
        <div className="step">
          <div className="ui">
            <div className="row">
              {product} <small>${price}</small>
            </div>
            <div className="row">
              {stock} in stock <small>${budget} at most</small>
            </div>
            <div className="row go">Let my agent plan it</div>
          </div>
          <p className="cap">
            <b>Step 1</b>Add your product, or start from your Instagram post. Your agent plans the match and the offer, and tells you why.
          </p>
        </div>
        <div className="step" style={{ ["--ca" as string]: ca, ["--cb" as string]: cb }}>
          <div className="ui">
            <div className="row url">tifo.vercel.app/p/your-drop</div>
            <div className="row lead">
              <span className="dots">
                <i />
                <i />
              </span>
              {A} v {B}
            </div>
            <div className="row" style={{ ["--k" as string]: 1 }}>
              {offerLabel(rates[0], A)}
            </div>
            <div className="row" style={{ ["--k" as string]: 2 }}>
              {offerLabel(rates[1], B)}
            </div>
          </div>
          <p className="cap">
            <b>Step 2</b>Share the link wherever you already sell. Fans pick a side and pay.
          </p>
        </div>
        <div className="step">
          <div className="ui">
            <div className="bars">
              {[38, 62, 100, 54].map((h, n) => (
                <i key={n} className={n === 2 ? "on" : ""} style={{ ["--h" as string]: `${h}%`, ["--n" as string]: n }} />
              ))}
            </div>
            <div className="row">
              Paid back to winners <small>up to ${budget}</small>
            </div>
          </div>
          <p className="cap">
            <b>Step 3</b>Your agent pays the winners, sends you your money and writes every dollar in your books.
          </p>
        </div>
      </div>

      <p className="trio-note">An example drop: 10 t-shirts at $20, 25% back for every buyer. The most it can cost is $50. Fans split between two teams and only one wins, so it usually costs about $20.</p>

      <div className="wrap">
        <Reveal className="facts">
          <div>
            <b>{cards.length}</b>
            <span>drops opened</span>
          </div>
          <div>
            <b>{orders}</b>
            <span>orders placed</span>
          </div>
          <div>
            <b>{settled}</b>
            <span>settled by the agent</span>
          </div>
          <div>
            <b>{byAgent}</b>
            <span>opened by the agent alone</span>
          </div>
        </Reveal>
      </div>

      <Duties />

      <section className="section wrap">
        <div className="fans">
          <Reveal>
            <span className="pill ac">If you are buying</span>
            <h2 style={{ marginTop: 14 }}>Buy what you wanted anyway. Money back if your team wins.</h2>
            <ol>
              <li>
                <span>
                  <b>Pay full price and pick your side</b>You keep what you bought whatever happens.
                </span>
              </li>
              <li>
                <span>
                  <b>Sign with Face ID</b>No seed phrase and no gas fees. A wallet is made for you in seconds.
                </span>
              </li>
              <li>
                <span>
                  <b>Your money back after full time</b>If your team wins, your share of the price comes back to you. It lands in your wallet by itself.
                </span>
              </li>
            </ol>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="step" style={{ rotate: "2deg", minHeight: 0, ["--ca" as string]: ca, ["--cb" as string]: cb }}>
              <div className="ui">
                <div className="row">
                  {product} <small>${price}</small>
                </div>
                <div className="row lead" style={{ boxShadow: "inset 0 0 0 2px var(--ink)", background: "var(--surface)" }}>
                  <span className="dots">
                    <i />
                  </span>
                  {offerLabel(rates[0], A)}
                </div>
                <div className="row">{offerLabel(rates[1], B)}</div>
                <div className="row go">Buy for ${price}</div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section wrap">
        <Reveal className="section-head">
          <h2>Questions sellers ask</h2>
        </Reveal>
        <Reveal className="faq">
          <details>
            <summary>Is it only for sales?</summary>
            <p>
              Sales come first, because that is what most small shops need. But your agent already does more: it keeps your books (every dollar in and out,
              with the reason), sends you your money after every sale, holds payment for delivered orders until the customer has them, collects delivery
              addresses, runs referrals, and plans your next promos by itself inside a weekly limit. Above the limit it asks you first.
            </p>
          </details>
          <details>
            <summary>Is this betting?</summary>
            <p>No. The buyer pays your normal price for a real product and keeps it whatever happens. The money back is a discount that depends on the result. Nobody can put money in without buying something.</p>
          </details>
          <details>
            <summary>What is the most it can cost me?</summary>
            <p>The figure your agent shows you before you post: your stock times the price times the share back. The contract will not hand out more than that, whoever wins. A draw costs far less.</p>
          </details>
          <details>
            <summary>When do I get paid?</summary>
            <p>Straight away. Each sale reaches you as it lands, apart from the part set aside for the money back. Whatever is left of that returns to you after the match.</p>
          </details>
          <details>
            <summary>Do my buyers need crypto?</summary>
            <p>They need USDC. Most big exchanges can send it on Arc, and the wallet is made with a fingerprint or Face ID. Tifo works best today for sellers whose buyers already hold some.</p>
          </details>
          <details>
            <summary>What can I sell?</summary>
            <p>
              Things you deliver, digital products and bookings. A download link or code opens on the page the moment the buyer pays. For things you deliver,
              the buyer adds their address after paying and the payment waits until they confirm it arrived. For services, each time slot can be booked once.
            </p>
          </details>
        </Reveal>

        <Reveal className="band">
          <h2>Give your shop an agent this weekend</h2>
          <p>Add one product and your agent plans the rest. It takes about a minute.</p>
          <a className="btn" href="/manage?new=1">
            Make a drop
          </a>
        </Reveal>
      </section>
    </>
  );
}
