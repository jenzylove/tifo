import DropCard from "@/components/DropCard";
import { dropCards } from "@/lib/board";
import { shortTeam } from "@/lib/matches";
import { inkOn, teamColors } from "@/lib/teams";

export const dynamic = "force-dynamic";

export default async function Landing() {
  const cards = await dropCards(undefined, 12).catch(() => []);
  const open = cards.filter((c) => c.phase === "open");
  const show = (open.length ? open : cards).slice(0, 3);
  const hero = open[0] ?? cards[0];
  const A = hero ? shortTeam(hero.p.meta.teamA) : "Arsenal";
  const B = hero ? shortTeam(hero.p.meta.teamB) : "Spurs";
  const [ca, cb] = hero ? teamColors(hero.p.meta.teamA, hero.p.meta.teamB) : ["#EF0107", "#132257"];
  const rates = hero?.rates ?? [1700, 4700];

  return (
    <>
      <section className="hero">
        <div className="aura" aria-hidden />
        <div className="wrap">
          <div>
            <span className="eyebrow">AI business manager for small shops</span>
            <h1>
              Turn every big match into <em>sales</em>.
            </h1>
            <p className="sub">
              Tifo is a manager for your shop. It picks the matches your buyers care about and runs a drop on your product. Fans of both teams buy at full price,
              and the winners get part of it back in USDC after full time. It also tracks your sales and cash and tells you what to do next.
            </p>
            <div className="ctas">
              <a className="btn" href="/manage">
                Open your shop, free
              </a>
              <a className="btn ghost" href={hero ? `/p/${hero.p.address}` : "/drops"}>
                See a live drop
              </a>
            </div>
            <div className="trust">
              <span>Your worst case is capped before kickoff</span>
              <span>Sign in with your fingerprint</span>
              <span>No gas fees</span>
            </div>
          </div>

          <div className="stage" aria-label="What Tifo looks like">
            <div className="float f-ai">
              <div className="who">
                <span className="orb" /> Your manager
              </div>
              <p>
                <b>
                  {A} v {B}
                </b>{" "}
                is the big one this week, and most of your buyers follow these two clubs. Run your best seller as a drop at a 10% average discount, with
                $60 as the most you can owe.
              </p>
              <span className="act">Set it up →</span>
            </div>
            <div className="float f-drop" style={{ ["--ca" as string]: ca, ["--cb" as string]: cb }}>
              <div className="ph">{hero?.p.meta.image ? <img src={hero.p.meta.image} alt="" /> : <span className="ph-name" style={{ fontSize: "1.5rem" }}>{hero?.p.meta.product ?? "Matchday hoodie"}</span>}</div>
              <div className="body">
                <b>{hero?.p.meta.product ?? "Matchday hoodie"}</b>
                <div className="sides">
                  <div style={{ background: ca, color: inkOn(ca) }}>
                    <b>{rates[0] / 100}%</b> back if {A} win
                  </div>
                  <div style={{ background: cb, color: inkOn(cb) }}>
                    <b>{rates[1] / 100}%</b> back if {B} win
                  </div>
                </div>
              </div>
            </div>
            <div className="float f-pay">
              <span className="tick">✓</span>
              <div>
                <b>Refunds sent</b>
                <span>Winning fans paid in USDC, seconds after full time</span>
              </div>
            </div>
            <div className="float f-cap">
              <b>Most you can owe</b>
              <div className="bar">
                <i />
              </div>
              <small>Set aside so far: 42% of your $60 cap</small>
            </div>
          </div>
        </div>
      </section>

      <div className="logos wrap" aria-label="Built with">
        <span>USDC on Arc</span>
        <span>Circle Wallets</span>
        <span>Claude</span>
        <span>Live odds from Polymarket</span>
      </div>

      <section className="section wrap">
        <div className="section-head">
          <span className="eyebrow">What your manager does</span>
          <h2>It works the match day so you can run the shop</h2>
          <p>You set up your shop once. The manager handles the rest and writes down every decision where you can check it.</p>
        </div>

        <div className="feature">
          <div>
            <span className="pill ac">1 · Plans the drop</span>
            <h3>Picks the match, prices both sides</h3>
            <p>
              It reads your catalog and the clubs your buyers follow, then picks a real fixture from the coming week. It prices each side from live market
              odds, so every fan gets the same expected discount and the underdog&apos;s fans get the bigger %.
            </p>
            <ul>
              <li>Your product at your price, nothing marked up</li>
              <li>You choose the most you&apos;re willing to owe</li>
              <li>Launch in one tap from your wallet</li>
            </ul>
          </div>
          <div className="demo">
            <div className="panel">
              <div className="mini-row">
                <span>Product</span>
                <b>
                  {hero?.p.meta.product ?? "Matchday hoodie"} · ${hero?.p.meta.priceUsd.toFixed(2) ?? "25.00"}
                </b>
              </div>
              <div className="mini-row">
                <span>Match</span>
                <b>
                  {A} v {B}
                </b>
              </div>
              <div className="mini-row">
                <span>{A} fans</span>
                <b>{rates[0] / 100}% back if they win</b>
              </div>
              <div className="mini-row">
                <span>{B} fans</span>
                <b>{rates[1] / 100}% back if they win</b>
              </div>
              <div className="mini-row">
                <span>Draw</span>
                <b>No rebate</b>
              </div>
            </div>
          </div>
        </div>

        <div className="feature flip">
          <div>
            <span className="pill ac">2 · Keeps the book balanced</span>
            <h3>Moves the offers while fans buy</h3>
            <p>
              When one side runs ahead, it raises the other side&apos;s offer to pull buyers over. It only ever sets aside enough to cover the bigger of the two
              refund bills. The rest of each sale goes straight to your wallet.
            </p>
            <ul>
              <li>Every change is written on chain with its reason</li>
              <li>It can&apos;t take your money or go past your cap</li>
            </ul>
          </div>
          <div className="demo">
            <div className="panel">
              <div className="mini-row">
                <span className="pill ok">Sale</span>
                <span>{A} fan · paid in full</span>
              </div>
              <div className="mini-row">
                <span className="pill ok">Sale</span>
                <span>{A} fan · paid in full</span>
              </div>
              <div className="mini-row">
                <span className="pill ac">Manager</span>
                <span>
                  {A} side is ahead. Raised {B} to pull the book back level.
                </span>
              </div>
              <div className="mini-row">
                <span className="pill ok">Sale</span>
                <span>{B} fan · paid in full</span>
              </div>
            </div>
          </div>
        </div>

        <div className="feature">
          <div>
            <span className="pill ac">3 · Pays out at full time</span>
            <h3>Checks the result, then settles by itself</h3>
            <p>
              After the final whistle it waits for two of three independent sources to agree on the score. Then it sends the winning fans their money and
              returns whatever was left over to you. You don&apos;t have to do anything.
            </p>
          </div>
          <div className="demo">
            <div className="panel">
              <div className="mini-row">
                <span>Result sources</span>
                <b>ESPN · TheSportsDB · Polymarket</b>
              </div>
              <div className="mini-row">
                <span>Agreement needed</span>
                <b>2 of 3</b>
              </div>
              <div className="mini-row">
                <span>Check window</span>
                <b>15 minutes</b>
              </div>
              <div className="mini-row">
                <span>Then</span>
                <b className="ok">Refunds and leftovers sent</b>
              </div>
            </div>
          </div>
        </div>

        <div className="feature flip">
          <div>
            <span className="pill ac">4 · Runs your numbers</span>
            <h3>A manager who reads your books every day</h3>
            <p>
              Your dashboard shows what came in, what&apos;s set aside, what each drop cost you and how many new fans it reached. Each time you open it, the
              manager writes a short briefing and suggests your next moves. Each suggestion is one tap to set up.
            </p>
          </div>
          <div className="demo">
            <div className="panel">
              <div style={{ display: "flex", gap: 10, alignItems: "center", fontWeight: 600, marginBottom: 10 }}>
                <span className="orb" /> Example briefing
              </div>
              <p className="muted" style={{ fontSize: ".92rem" }}>
                Two drops brought in 14 orders from 11 new fans, and refunds cost you 6% of those sales. Saturday&apos;s derby is the best fit for your
                buyers. Your hoodie still has no photo, so add one first.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section wrap">
        <div className="section-head">
          <span className="eyebrow">For fans</span>
          <h2>Back your team and keep what you bought</h2>
          <p>You pay with your fingerprint. A wallet is created for you in seconds, with no app to install and no gas to pay.</p>
        </div>
        <div className="steps3">
          <div>
            <b>1</b>
            <h4>Pick your team</h4>
            <p>Your rebate % is locked the moment you buy. The shop delivers your order as usual.</p>
          </div>
          <div>
            <b>2</b>
            <h4>Watch the match</h4>
            <p>Each order shows up as a tile in your team&apos;s stand on the drop page.</p>
          </div>
          <div>
            <b>3</b>
            <h4>Get paid if you win</h4>
            <p>If your team wins, the money lands in your wallet after full time. A draw pays no rebate.</p>
          </div>
        </div>
      </section>

      {show.length > 0 && (
        <section className="section wrap">
          <h2 className="h">
            Live drops{" "}
            <a href="/drops" className="link">
              See all
            </a>
          </h2>
          <div className="drops">
            {show.map((c) => (
              <DropCard key={c.p.address} {...c} />
            ))}
          </div>
        </section>
      )}

      <section className="section wrap">
        <div className="section-head">
          <h2>Questions shops ask</h2>
        </div>
        <div className="faq">
          <details>
            <summary>Is this betting?</summary>
            <p>
              No. The fan buys your product at your normal price and keeps it whatever happens. The rebate is a discount that depends on the result, and
              nobody can stake money without buying something.
            </p>
          </details>
          <details>
            <summary>What&apos;s the most I can lose?</summary>
            <p>
              The cap you set before kickoff. The contract won&apos;t take an order that would push either refund bill past it. In practice you owe much
              less, because only one side can win and a draw pays nothing.
            </p>
          </details>
          <details>
            <summary>When do I get paid?</summary>
            <p>
              Straight away. Each sale goes to your wallet as soon as it lands, minus the small part set aside for refunds. Whatever is left of that comes
              back to you after the match.
            </p>
          </details>
          <details>
            <summary>Do my customers need crypto?</summary>
            <p>
              They need USDC on Arc. They can withdraw it from most big exchanges, and the wallet is created with a fingerprint or Face ID. There are no gas
              fees and no seed phrase.
            </p>
          </details>
        </div>

        <div className="cta-band">
          <h2>Give your shop a manager for match day</h2>
          <p>Set up your page, add your products, and let it plan your first drop. It takes about five minutes.</p>
          <a className="btn" href="/manage">
            Open your shop
          </a>
        </div>
      </section>
    </>
  );
}
