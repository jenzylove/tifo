"use client";
// The seller's standing rule for their manager: how much it may put at risk each week without asking,
// what it plans to do next and why, and the proposals that need the seller's answer.
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import type { SmartAccount } from "viem/account-abstraction";
import { explorerAddr } from "@/lib/chain";
import { biometric, createAccountWithCircle, decideWithCircle, setLimitsWithCircle, walletError, withdrawFromAccountWithCircle } from "@/lib/circleWallet";
import type { Plan } from "@/lib/autopilot";
import type { ManagerData } from "@/lib/manager";
import { shortTeam } from "@/lib/matches";
import { handleTap, type Retry } from "@/lib/tap";

const $ = (units: string | number) => `$${(Number(units) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const units = (usd: number) => BigInt(Math.round(usd * 1e6));

export default function Autopilot({ data, acct, reload }: { data: ManagerData; acct: SmartAccount; reload: () => void }) {
  const a = data.account;
  const [base, setBase] = useState(a ? Number(a.baseWeekly) / 1e6 : 25);
  const [share, setShare] = useState(a ? a.weeklyBps / 100 : 10);
  const [perDrop, setPerDrop] = useState(a ? Number(a.perDealCap) / 1e6 : 25);
  const [status, setStatus] = useState<{ kind: "idle" | "working" | "ok" | "err"; text?: string }>({ kind: "idle" });
  const [retry, setRetry] = useState<Retry>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planErr, setPlanErr] = useState("");
  const [thinking, setThinking] = useState(false);

  const fetchPlan = useCallback(
    async (fresh = false) => {
      setThinking(true);
      setPlanErr("");
      try {
        const r = await fetch(`/api/autopilot?address=${acct.address}${fresh ? "&fresh=1" : ""}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setPlan(j);
      } catch (e) {
        setPlanErr((e as Error).message);
      } finally {
        setThinking(false);
      }
    },
    [acct.address],
  );
  useEffect(() => {
    if (a) fetchPlan();
  }, [a?.address, fetchPlan]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Run one wallet action with the Face ID prompt, then reload the numbers from chain. */
  async function run(label: string, action: () => Promise<unknown>) {
    setStatus({ kind: "working", text: `Confirm with ${biometric()}. Gas is covered.` });
    const finish = () => {
      setStatus({ kind: "ok", text: label });
      reload();
    };
    try {
      await action();
      finish();
    } catch (e) {
      const fail = (text: string) => setStatus({ kind: "err", text });
      if (handleTap(e, finish, fail, setRetry)) return setStatus({ kind: "idle" });
      fail(walletError(e));
    }
  }

  const rule = (
    <>
      <div className="grid2">
        <label className="field">
          Each week, up to <small>USDC it may put at risk across all drops</small>
          <input className="input" type="number" min={0} step="1" value={base} onChange={(e) => setBase(Math.max(0, Number(e.target.value)))} />
        </label>
        <label className="field">
          Plus a share of last week&apos;s sales <small>{share}% of what your drops sold in the last 7 days</small>
          <input type="range" min={0} max={30} value={share} onChange={(e) => setShare(Number(e.target.value))} />
        </label>
      </div>
      <label className="field">
        Most for one drop <small>anything bigger comes to you as a proposal</small>
        <input className="input" type="number" min={1} step="1" value={perDrop} onChange={(e) => setPerDrop(Math.max(1, Number(e.target.value)))} />
      </label>
    </>
  );
  const feedback = (
    <>
      {retry && (
        <button className="btn" onClick={retry}>
          Confirm with {biometric()}
        </button>
      )}
      {status.text && <p className={`status ${status.kind === "err" ? "err" : status.kind === "ok" ? "ok" : ""}`}>{status.text}</p>}
    </>
  );

  if (!a)
    return (
      <>
        <div className="mgr-head">
          <div>
            <h1>Autopilot</h1>
            <p className="muted">Let your manager run drops for you, inside a limit you set. It can never take money out, and anything over the limit waits for your yes.</p>
          </div>
        </div>
        <div className="panel launch" style={{ maxWidth: 640 }}>
          <h3>Set your rule</h3>
          {rule}
          <p className="fine">
            This opens an account on Arc that only you control. Sales from your drops land in it, and you can move them to your wallet at any time. Your manager
            can open a drop from it only inside this rule.
          </p>
          <button className="btn" hidden={!!retry} disabled={status.kind === "working"} onClick={() => run("Autopilot is on.", () => createAccountWithCircle(acct, Math.round(share * 100), units(base), units(perDrop)))}>
            Turn on autopilot
          </button>
          {feedback}
        </div>
      </>
    );

  const left = Math.max(0, Number(a.allowance) - Number(a.committed));
  const waiting = a.proposals.filter((p) => p.status === "waiting");
  const answered = a.proposals.filter((p) => p.status !== "waiting").slice(0, 5);
  return (
    <>
      <div className="mgr-head">
        <div>
          <h1>Autopilot</h1>
          <p className="muted">Your manager runs drops inside your rule and asks before going over it.</p>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi">
          <span>Left this week</span>
          <b>{$(left)}</b>
        </div>
        <div className="kpi">
          <span>Allowed this week</span>
          <b>{$(a.allowance)}</b>
        </div>
        <div className="kpi">
          <span>Already put at risk</span>
          <b>{$(a.committed)}</b>
        </div>
        <div className="kpi">
          <span>In your account</span>
          <b>{$(a.balance)}</b>
        </div>
      </div>

      {waiting.length > 0 && (
        <div className="panel" style={{ marginTop: 18 }}>
          <h3>Waiting for your answer</h3>
          {waiting.map((p) => (
            <div key={p.id} className="move" style={{ marginTop: 10 }}>
              <b>
                {p.meta ? `${shortTeam(p.meta.teamA)} v ${shortTeam(p.meta.teamB)} · ` : ""}budget {$(p.cap)}
              </b>
              <p>{p.reason}</p>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn sm" disabled={status.kind === "working"} onClick={() => run("Approved. The drop is open.", () => decideWithCircle(acct, a.address, p.id, true))}>
                  Approve
                </button>
                <button className="btn sm ghost" disabled={status.kind === "working"} onClick={() => run("Declined.", () => decideWithCircle(acct, a.address, p.id, false))}>
                  Decline
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="brief" style={{ marginTop: 18 }}>
        <header>
          <span className="orb" />
          <div>
            <b>What your manager plans next</b>
            <span>{plan ? `Checked ${new Date(plan.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Reading your past drops and the coming fixtures…"}</span>
          </div>
          <button className="link" onClick={() => fetchPlan(true)} disabled={thinking}>
            {thinking ? "Thinking…" : "Ask again"}
          </button>
        </header>
        {planErr && <p className="status err">{planErr}</p>}
        {!plan && !planErr && <div className="skeleton" style={{ width: "80%" }} />}
        {plan && (
          <>
            {plan.act !== "skip" && (
              <p className="summary">
                <b>
                  {plan.act === "open" ? "It will run" : "It wants to run"} {plan.match} with a ${plan.capUsd} budget.
                </b>{" "}
                {plan.offers?.join(" · ")}
                {plan.spots ? ` · covers ${plan.spots} ${plan.spots === 1 ? "buyer" : "buyers"} per side` : ""}
                {plan.breakEvenSales ? ` · pays for itself at ${plan.breakEvenSales} extra ${plan.breakEvenSales === 1 ? "sale" : "sales"}` : ""}
              </p>
            )}
            <p className="summary">{plan.reason}</p>
            <p className="fine">
              {plan.act === "open"
                ? "This is inside your rule, so it opens the drop on its next round without asking."
                : plan.act === "propose"
                  ? "This is over your rule, so it will send you a proposal instead of acting."
                  : "It is not opening anything right now."}
            </p>
          </>
        )}
      </section>

      <div className="two">
        <div className="panel launch">
          <h3>Your rule</h3>
          {rule}
          <button className="btn" hidden={!!retry} disabled={status.kind === "working"} onClick={() => run("Rule saved.", () => setLimitsWithCircle(acct, a.address, Math.round(share * 100), units(base), units(perDrop)))}>
            Save rule
          </button>
          {feedback}
        </div>
        <div className="panel">
          <h3>Your account</h3>
          <div className="mini-row">
            <span>Balance</span>
            <b>{$(a.balance)}</b>
          </div>
          <div className="mini-row">
            <span>Sales in the last 7 days</span>
            <b>{$(a.recentSales)}</b>
          </div>
          <button
            className="btn sm"
            style={{ marginTop: 12 }}
            disabled={BigInt(a.balance) === 0n || status.kind === "working"}
            onClick={() => run("Moved to your wallet.", () => withdrawFromAccountWithCircle(acct, a.address, acct.address as Address, BigInt(a.balance)))}
          >
            Move it all to my wallet
          </button>
          <p className="fine" style={{ marginTop: 12 }}>
            Only your wallet can take money out. Your manager can open drops inside your rule and nothing else. The rule is enforced by{" "}
            <a href={explorerAddr(a.address)} target="_blank" rel="noreferrer">
              your account contract on Arc
            </a>
            .
          </p>
          {answered.length > 0 && (
            <>
              <h3 style={{ marginTop: 14 }}>Past proposals</h3>
              {answered.map((p) => (
                <div key={p.id} className="mini-row">
                  <span>{p.meta ? `${shortTeam(p.meta.teamA)} v ${shortTeam(p.meta.teamB)}` : "Proposal"} · {$(p.cap)}</span>
                  <b>{p.status === "approved" ? "Approved" : "Declined"}</b>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}
