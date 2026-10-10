import type { CSSProperties } from "react";
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
  // Every figure on this page is read from the chain. With no drops yet, the product cards show a plain example instead.
  const live = cards.find((c) => c.phase === "open") ?? cards[0];
  const paid = cards.find((c) => c.phase === "settled" && c.note?.includes("paid back"));
  const paidState = paid ? await promoState(paid.p.address).catch(() => null) : null;
  const settled = cards.filter((c) => c.phase === "settled").length;
  const orders = cards.reduce((t, c) => t + c.fans, 0);
  const A = live ? shortTeam(live.p.meta.teamA) : "Arsenal";
  const B = live ? shortTeam(live.p.meta.teamB) : "Chelsea";
  const [ca, cb] = live ? teamColors(live.p.meta.teamA, live.p.meta.teamB) : ["#111114", "#a78bfa"];
  const rates = live?.rates ?? [10_000, 10_000];
  const product = live?.p.meta.product ?? "Budget template";
  const price = live?.p.meta.priceUsd ?? 20;
  const budget = live ? Number(live.p.cap) / 1e6 : 100;

  return (
    <>
      <section className="hero wrap">
        <a className="news" href="/proof">
          <b>Live</b>
          {paidState ? (
            <span>
              The last winners got <strong>{usd(paidState.refundedTotal)}</strong> back<em>. See the proof</em>
            </span>
          ) : (
            <span>
              Every payout is on Arc<em>. See the proof</em>
            </span>
          )}
        </a>
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
            <span className="sticker">money back for the winners</span>
          </span>
        </h1>
        <p className="sub">
          Give Tifo one product and a budget. It hands you a link to share. Fans of both teams buy, the winning side gets money back, and it never costs you
          more than the budget you set.
        </p>
        <div className="ctas">
          <a className="btn ac" href="/manage">
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
              {product.length > 22 ? `${product.slice(0, 22)}…` : product} <small>${price.toFixed(2)}</small>
            </div>
            <div className="row">
              Budget <small>${budget.toFixed(2)} at most</small>
            </div>
            <div className="row go">Get my link</div>
          </div>
          <p className="cap">
            <b>Step 1</b>Add one product and the most you are willing to spend.
          </p>
        </div>
        <div className="step" style={{ ["--ca" as string]: ca, ["--cb" as string]: cb }}>
          <div className="ui">
            <div className="row url">tifo.vercel.app/p/{live ? live.p.address.slice(2, 10) : "your-drop"}</div>
            <div className="row lead">
              <span className="dots">
                <i />
                <i />
              </span>
              {A} v {B}
            </div>
            <div className="row">
              {offerLabel(rates[0], A)}
            </div>
            <div className="row">
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
              {paidState ? "Paid back to winners" : "Winners paid after full time"} <small>{paidState ? usd(paidState.refundedTotal) : "in USDC"}</small>
            </div>
          </div>
          <p className="cap">
            <b>Step 3</b>Winners get paid by themselves. You see what the drop brought in against what it cost.
          </p>
        </div>
      </div>

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
            <b>$0</b>
            <span>gas paid by buyers</span>
          </div>
        </Reveal>
      </div>

      <section className="section wrap">
        <Reveal className="section-head">
          <span className="pill ac">Your sales manager</span>
          <h2>It does the work. You set the limit.</h2>
          <p>Tifo is an AI sales manager with a budget it has to earn back. Every decision it makes is written down where you can check it.</p>
        </Reveal>
        <div className="duties">
          {[
            ["Plans the drop", "It looks at how your past drops went and the matches coming up, then picks one and sets the offer. It tells you how many extra sales pay for it before you say yes."],
            ["Keeps both sides fair", "As one team's fans pile in, it moves the offers so your cost stays the same whoever wins. It can never go over your budget, because a contract holds the money, not the AI."],
            ["Pays the winners", "It checks the result against three sources and pays as soon as two agree. No claim form, no waiting a week."],
            ["Shows you the score", "After every match you see what the drop brought in, what it cost, and whether it paid for itself."],
            ["Runs on autopilot, if you let it", "Give it a weekly limit and it runs drops for you. Anything bigger than the limit, it has to ask first. It can never take money out."],
          ].map(([title, text], n) => (
            <Reveal key={title} className="duty" delay={n * 0.05}>
              <span className="n">0{n + 1}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="section wrap">
        <div className="fans">
          <Reveal>
            <span className="pill ac">If you are buying</span>
            <h2 style={{ marginTop: 14 }}>Buy what you wanted anyway. Get money back if your team wins.</h2>
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
                  <b>Money back after full time</b>It lands in your wallet by itself. On a draw everyone gets a small thank you.
                </span>
              </li>
            </ol>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="step" style={{ rotate: "2deg", minHeight: 0, ["--ca" as string]: ca, ["--cb" as string]: cb }}>
              <div className="ui">
                <div className="row">
                  {product.length > 26 ? `${product.slice(0, 26)}…` : product} <small>${price.toFixed(2)}</small>
                </div>
                <div className="row lead" style={{ boxShadow: "inset 0 0 0 2px var(--ink)", background: "var(--surface)" }}>
                  <span className="dots">
                    <i />
                  </span>
                  {offerLabel(rates[0], A)}
                </div>
                <div className="row">{offerLabel(rates[1], B)}</div>
                <div className="row go">Buy for ${price.toFixed(2)}</div>
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
            <summary>Is this betting?</summary>
            <p>No. The buyer pays your normal price for a real product and keeps it whatever happens. The money back is a discount that depends on the result. Nobody can put money in without buying something.</p>
          </details>
          <details>
            <summary>What is the most it can cost me?</summary>
            <p>The budget you set before kickoff. The contract will not hand out more than that, whoever wins. A draw costs far less.</p>
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
            <p>Anything, but digital products work best. A download link or an access code opens on the page the moment the buyer pays, so there is nothing to ship.</p>
          </details>
        </Reveal>

        <Reveal className="band">
          <h2>Your next sale could start at kickoff</h2>
          <p>Add one product, set a budget and share the link. It takes about a minute.</p>
          <a className="btn" href="/manage">
            Make a drop
          </a>
        </Reveal>
      </section>
    </>
  );
}
