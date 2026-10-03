import { listPromos, promoState } from "@/lib/promos";
import { shortTeam } from "@/lib/matches";
import { inkOn, teamColors } from "@/lib/teams";
import { usd } from "@/lib/chain";

export const dynamic = "force-dynamic";

export default async function Home() {
  const promos = await listPromos();
  const rows = await Promise.all(promos.slice(0, 24).map(async (p) => ({ p, st: await promoState(p.address) })));
  const now = Date.now() / 1000;
  const open = rows.filter((r) => r.st.closesAt > now);
  const done = rows.filter((r) => r.st.closesAt <= now);
  return (
    <section className="home">
      <h1 className="hero">
        Both sets of fans buy.
        <br />
        <em>The winners get paid back.</em>
      </h1>
      <p className="lede">
        Tifo turns a weekend match into a sale for small shops. Fans of each team buy at full price, and the winning side gets a rebate in USDC on Arc seconds
        after the final whistle. An AI agent prices both sides from live odds and keeps the shop&apos;s worst case capped before kickoff.
      </p>
      <p>
        <a className="cta" href="/sell">
          Run a drop for your shop
        </a>
      </p>

      <h2 className="section-title">This matchday</h2>
      {open.length === 0 && <p className="fine">No drops open right now. Start one from the next fixtures.</p>}
      <div className="board">{open.map((r) => card(r))}</div>

      {done.length > 0 && (
        <>
          <h2 className="section-title">Full time</h2>
          <div className="board">{done.map((r) => card(r))}</div>
        </>
      )}

      <h2 className="section-title">How it works</h2>
      <div className="steps">
        <div>
          <b>The shop tells the agent what it sells.</b>
          It picks a real match the shop&apos;s buyers care about and prices both sides from live market odds. Underdog fans get a bigger %.
        </div>
        <div>
          <b>Fans buy with Face ID.</b>
          A Circle wallet, USDC on Arc, no gas. Each fan&apos;s % is locked when they buy. The agent shifts offers as one side runs ahead.
        </div>
        <div>
          <b>Full time pays out by itself.</b>
          Once two independent sources agree on the result, the winning fans are refunded in seconds. The shop never owes more than its cap.
        </div>
      </div>
    </section>
  );
}

function card({ p, st }: { p: Awaited<ReturnType<typeof listPromos>>[number]; st: Awaited<ReturnType<typeof promoState>> }) {
  const [ca, cb] = teamColors(p.meta.teamA, p.meta.teamB);
  const status =
    st.finalOutcome !== "None"
      ? st.finalOutcome === "A" || st.finalOutcome === "B"
        ? `${usd(st.refundedTotal)} paid back`
        : st.finalOutcome
      : Date.now() / 1000 < st.closesAt
        ? `${st.ordersCount} fans in · ${p.meta.shop}`
        : "awaiting result";
  return (
    <a key={p.address} href={`/p/${p.address}`} className="card" style={{ ["--ca" as string]: ca, ["--cb" as string]: cb, ["--ia" as string]: inkOn(ca), ["--ib" as string]: inkOn(cb) }}>
      <div className="ca">
        <span className="t">{shortTeam(p.meta.teamA)}</span>
        <span className="o">{st.rates[0] / 100}%</span>
      </div>
      <div className="cb">
        <span className="t">{shortTeam(p.meta.teamB)}</span>
        <span className="o">{st.rates[1] / 100}%</span>
      </div>
      <span className="meta">{status}</span>
    </a>
  );
}
