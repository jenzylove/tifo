import { agentLog } from "@/lib/agentLog";
import { explorerAddr, NETWORK, usd } from "@/lib/chain";
import { isCheckDrop, listPromos, promoOrders, promoState } from "@/lib/promos";
import { agentRecord } from "@/lib/record";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent log · Tifo", description: "Every decision Tifo's agent made, read live from Arc." };

const when = (at: number) => new Date(at * 1000).toUTCString().slice(5, 22) + " UTC";

export default async function AgentLog() {
  const promos = (await listPromos()).filter((p) => !isCheckDrop(p.meta));
  const [log, rows] = await Promise.all([
    agentLog(),
    Promise.all(
      promos.map(async (p) => {
        const st = await promoState(p.address);
        const orders = await promoOrders(p.address, st.ordersCount);
        return { p, st, volume: orders.reduce((t, o) => t + o.amount, 0n) };
      }),
    ),
  ]);
  const record = await agentRecord(rows);
  const alone = log.entries.filter((e) => e.alone).length;
  return (
    <section className="wrap">
      <div className="pagehead">
        <span className="eyebrow">Read live from Arc {NETWORK}</span>
        <h1>Agent log</h1>
        <p>
          Every line below is something Tifo&apos;s agent did, in its own words, as it wrote them on chain. Nobody can edit or delete them, us
          included. Each one links to the contract that holds it.
        </p>
      </div>
      <div className="stats">
        <div className="kpi"><span>Decisions on chain</span><b>{log.entries.length}</b></div>
        <div className="kpi"><span>Done with nobody clicking</span><b>{alone}</b></div>
        <div className="kpi"><span>Results settled by itself</span><b>{record.settled} of {record.due}</b></div>
        <div className="kpi"><span>Money back paid to fans</span><b>{usd(record.paidBack)}</b></div>
        <div className="kpi"><span>Asked the seller first</span><b>{record.asked}</b></div>
      </div>
      <p className="fine">
        How it works: the agent runs every two minutes. It plans each shop&apos;s drop, watches sales, reads match results from three sources and
        pays only when two agree, sends fans of the winning club their money back and returns the rest to the shop. Inside the weekly limit a shop sets on chain it
        acts alone; above it the contract refuses, so it can only ask. Our own test drops are left out.
      </p>
      {log.entries.length === 0 ? (
        <p className="empty panel">Nothing yet. The first decisions appear here as soon as a drop runs.</p>
      ) : (
        <ol className="agent-log">
          {log.entries.map((e, i) => (
            <li key={i} className="panel">
              <div className="agent-log-head">
                <span className={`pill ${e.alone ? "ac" : ""}`}>{e.what}</span>
                <span className="fine">
                  {e.shop} · {when(e.at)}
                </span>
              </div>
              {e.why && <p>{e.why}</p>}
              <p className="fine">
                {e.drop && (
                  <>
                    <a href={`/p/${e.drop}`}>See the drop</a> ·{" "}
                  </>
                )}
                <a href={explorerAddr(e.where)} target="_blank" rel="noreferrer">
                  On Arc
                </a>
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
