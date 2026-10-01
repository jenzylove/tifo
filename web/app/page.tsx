import { listPromos, promoState } from "@/lib/promos";
import { shortTeam } from "@/lib/matches";
import { usd } from "@/lib/chain";

export const dynamic = "force-dynamic";

export default async function Home() {
  const promos = await listPromos();
  const live = await Promise.all(promos.slice(0, 12).map(async (p) => ({ p, st: await promoState(p.address) })));
  return (
    <section className="page home">
      <h1 className="hero">Both sets of fans buy.<br />The winners&apos; fans get paid back.</h1>
      <p className="lede">
        Tifo runs match promos for small shops. Fans of each team buy at full price, and the winning side gets a rebate in USDC on Arc seconds after the
        final whistle. The shop&apos;s worst case is capped before kickoff, whoever wins.
      </p>
      <p><a className="cta" href="/sell">Run a promo for your shop</a></p>
      <h2>Promos</h2>
      {live.length === 0 && <p className="fine">No promos yet. The first one goes live this weekend.</p>}
      <ul className="promos">
        {live.map(({ p, st }) => (
          <li key={p.address}>
            <a href={`/p/${p.address}`}>
              <b>{shortTeam(p.meta.teamA)} v {shortTeam(p.meta.teamB)}</b> · {p.meta.shop} · {st.rates[0] / 100}% / {st.rates[1] / 100}% ·{" "}
              {st.ordersCount} buyers · {st.finalOutcome === "None" ? (Date.now() / 1000 < st.closesAt ? "open" : "awaiting result") : `settled: ${st.finalOutcome}`} · reserve {usd(st.reserve)}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
