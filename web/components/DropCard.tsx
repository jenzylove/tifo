import { shortTeam } from "@/lib/matches";
import type { PromoSummary } from "@/lib/promos";
import { offerLabel } from "@/lib/precheck";
import { inkOn, teamColors } from "@/lib/teams";

export interface DropCardData {
  p: PromoSummary;
  rates: [number, number];
  phase: "open" | "live" | "result" | "settled";
  fans: number;
  note?: string;
  base?: string; // another site that hosts this drop (the practice version)
}

/** One drop as a product card: photo first, the match as the promo layer on top. */
export default function DropCard({ p, rates, phase, fans, note, base = "" }: DropCardData) {
  const [ca, cb] = teamColors(p.meta.teamA, p.meta.teamB);
  const A = shortTeam(p.meta.teamA), B = shortTeam(p.meta.teamB);
  const kick = new Date(p.meta.kickoff);
  return (
    <a href={`${base}/p/${p.address}`} className="dcard" style={{ ["--ca" as string]: ca, ["--cb" as string]: cb }}>
      <div className="ph">
        {p.meta.image ? <img src={p.meta.image} alt={p.meta.product} /> : <span className="ph-name">{p.meta.product}</span>}
        {phase === "open" ? (
          <span className="pill">Kicks off {kick.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</span>
        ) : phase === "live" ? (
          <span className="pill live">Match on</span>
        ) : (
          <span className="pill">Full time</span>
        )}
      </div>
      <div className="scarf" />
      <div className="body">
        <span className="shopname">{p.meta.shop}</span>
        <h3>{p.meta.product}</h3>
        <span className="match">
          {A} v {B} · <span className="price">${p.meta.priceUsd.toFixed(2)}</span>
        </span>
        <div className="offers">
          <span style={{ background: ca, color: inkOn(ca) }}>{offerLabel(rates[0], A)}</span>
          <span style={{ background: cb, color: inkOn(cb) }}>{offerLabel(rates[1], B)}</span>
        </div>
        {note ? <span className="fine">{note}</span> : fans > 0 ? <span className="fine">{fans} {fans === 1 ? "order" : "orders"} so far</span> : null}
      </div>
    </a>
  );
}
