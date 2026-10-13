import DropCard from "@/components/DropCard";
import { dropCards } from "@/lib/board";
import { practice } from "@/lib/chain";

export const dynamic = "force-dynamic";

export default async function Drops() {
  const [cards, practiceCards] = await Promise.all([
    dropCards(),
    practice ? dropCards(undefined, 24, practice).catch(() => []) : Promise.resolve([]),
  ]);
  const open = cards.filter((c) => c.phase === "open");
  const rest = cards.filter((c) => c.phase !== "open");
  // Open practice drops first, then the finished ones so people can see a payout already done.
  const practiceSorted = [...practiceCards.filter((c) => c.phase === "open"), ...practiceCards.filter((c) => c.phase !== "open")];
  return (
    <div className="wrap">
      <div className="pagehead">
        <span className="eyebrow">This matchday</span>
        <h1>Live drops</h1>
        <p>Real products from independent sellers. Pick your team when you buy. If they win, you get money back after full time.</p>
      </div>
      {open.length === 0 ? <p className="empty panel">No drops open right now. Shops open new ones before each matchday.</p> : <div className="drops">{open.map((c) => <DropCard key={c.p.address} {...c} />)}</div>}
      {rest.length > 0 && (
        <>
          <h2 className="h">Full time <small>finished drops and their payouts</small></h2>
          <div className="drops">{rest.map((c) => <DropCard key={c.p.address} {...c} />)}</div>
        </>
      )}
      {practice && practiceSorted.length > 0 && (
        <section className="practice" id="practice">
          <h2 className="h">
            Try it with test money <small>practice drops on Arc testnet</small>
          </h2>
          <p className="practice-note">
            These work exactly like the real ones, with free test USDC. Get some at{" "}
            <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">faucet.circle.com</a>, buy one, pick your side and watch the refund land after full time. Nothing is shipped. Sellers can open their own practice drop first to see it settle before using real money.
          </p>
          <div className="drops">{practiceSorted.map((c) => <DropCard key={c.p.address} {...c} base={practice!.url} />)}</div>
          <p className="practice-more">
            <a href={`${practice.url}/manage`} className="btn sm">Open a practice drop</a>
          </p>
        </section>
      )}
    </div>
  );
}
