import DropCard from "@/components/DropCard";
import { dropCards } from "@/lib/board";

export const dynamic = "force-dynamic";

export default async function Drops() {
  const cards = await dropCards();
  const open = cards.filter((c) => c.phase === "open");
  const rest = cards.filter((c) => c.phase !== "open");
  return (
    <div className="wrap">
      <div className="pagehead">
        <span className="eyebrow">This matchday</span>
        <h1>Live drops</h1>
        <p>Real products from independent sellers. Pick your team when you buy. If they win, the first buyers on each side get the full price back after full time.</p>
      </div>
      {open.length === 0 ? <p className="empty panel">No drops open right now. Shops open new ones before each matchday.</p> : <div className="drops">{open.map((c) => <DropCard key={c.p.address} {...c} />)}</div>}
      {rest.length > 0 && (
        <>
          <h2 className="h">Full time <small>finished drops and their payouts</small></h2>
          <div className="drops">{rest.map((c) => <DropCard key={c.p.address} {...c} />)}</div>
        </>
      )}
    </div>
  );
}
