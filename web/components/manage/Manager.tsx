"use client";
// The seller's side of Tifo: an AI manager that reads their books, plans drops and runs the money.
import { useCallback, useEffect, useState } from "react";
import { isAddress, type Address } from "viem";
import { setAccount, useAccount } from "@/lib/account";
import { NETWORK, explorerTx } from "@/lib/chain";
import Books from "./Books";
import ShareDrop from "@/components/ShareDrop";
import GoogleButton from "@/components/GoogleButton";
import { googleEnabled } from "@/lib/googleWallet";
import { handleTap, type Retry } from "@/lib/tap";
import { usePasskeyReady } from "@/lib/usePasskeyReady";
import { biometric, circleEnabled, connectCircle, preparePasskey, savedCredential, sendUsdcWithCircle, usdcBalance, walletError } from "@/lib/circleWallet";
import type { Brief } from "@/lib/brief";
import type { ManagerData } from "@/lib/manager";
import { shortTeam } from "@/lib/matches";
import { teamColors } from "@/lib/teams";
import Autopilot from "./Autopilot";
import Launch, { type Prefill } from "./Launch";

type Tab = "overview" | "drops" | "autopilot" | "money";
const $ = (units: string | bigint | number) => `$${(Number(units) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function Manager() {
  const acct = useAccount();
  const [data, setData] = useState<ManagerData | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [prefill, setPrefill] = useState<Prefill>();
  useEffect(() => {
    if (new URLSearchParams(location.search).has("new")) setTab("drops");
  }, []);

  const load = useCallback(async () => {
    if (!acct) return;
    try {
      const r = await fetch(`/api/manager?address=${acct.address}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setData(j);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [acct]);
  useEffect(() => {
    load();
  }, [load]);

  if (!acct) return <SignIn />;
  if (!data) return <div className="wrap" style={{ padding: "60px 16px" }}>{err ? <p className="status err">{err}</p> : <div className="skeleton" style={{ maxWidth: 420, height: 28 }} />}</div>;

  const fresh = data.drops.length === 0;
  const view: Tab = fresh && tab === "overview" ? "drops" : tab;
  const who = data.name ?? "Your drops";
  const go = (t: Tab) => {
    setTab(t);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return (
    <div className="wrap mgr">
      <nav className="side-nav">
        <div className="me">
          <div className="logo">{who.slice(0, 1)}</div>
          <div>
            <b>{who}</b>
            <span className="fine">
              {acct.address.slice(0, 6)}…{acct.address.slice(-4)}
            </span>
          </div>
        </div>
        {(
          [
            ["overview", "Overview"],
            ["drops", "Match drops"],
            ["autopilot", "Autopilot"],
            ["money", "Books"],
          ] as [Tab, string][]
        ).map(([t, l]) => (
          <button key={t} className={view === t ? "on" : ""} onClick={() => go(t)}>
            {l}
            {t === "drops" && data.totals.live > 0 && <span className="pill live">{data.totals.live}</span>}
            {t === "autopilot" && (data.account?.proposals.filter((p) => p.status === "waiting").length ?? 0) > 0 && <span className="pill ac">1</span>}
          </button>
        ))}
      </nav>

      <div>
        {view === "overview" && (
          <Overview
            data={data}
            seller={acct.address}
            onMove={(p) => {
              setPrefill(p);
              go("drops");
            }}
          />
        )}
        {view === "drops" && (
          <>
            <div className="mgr-head">
              <div>
                <h1>Match drops</h1>
                <p className="muted">One product, one match, one link. Your budget is enforced by a contract, not by the AI.</p>
              </div>
            </div>
            <Launch
              account={acct}
              sellerName={data.name}
              tifoAccount={data.account?.current ? data.account.address : undefined}
              prefill={prefill}
              onLaunched={() => {
                // Stay on this tab: a first drop would otherwise flip the view to Overview and hide the new link.
                setTab("drops");
                load();
              }}
            />
            <div className="panel" style={{ marginTop: 18 }}>
              <h3>All drops</h3>
              <DropList data={data} />
            </div>
          </>
        )}
        {view === "autopilot" && <Autopilot data={data} acct={acct} reload={load} />}
        {view === "money" && <Money data={data} />}
      </div>
    </div>
  );
}

function Overview({ data, seller, onMove }: { data: ManagerData; seller: Address; onMove: (p: Prefill) => void }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [bErr, setBErr] = useState("");
  const [loading, setLoading] = useState(false);
  const fetchBrief = useCallback(
    async (fresh = false) => {
      setLoading(true);
      setBErr("");
      try {
        const r = await fetch(`/api/brief?address=${seller}${fresh ? "&fresh=1" : ""}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setBrief(j);
      } catch (e) {
        setBErr((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [seller],
  );
  useEffect(() => {
    fetchBrief();
  }, [fetchBrief]);

  const t = data.totals;
  const hour = new Date().getHours();
  const hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <>
      <div className="mgr-head">
        <div>
          <p className="muted">{hello}</p>
          <h1>{data.name}</h1>
        </div>
      </div>

      <section className="brief">
        <header>
          <span className="orb" />
          <div>
            <b>Your manager&apos;s briefing</b>
            <span>{brief ? `Updated ${new Date(brief.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Reading your books and the coming fixtures…"}</span>
          </div>
          <button className="link" onClick={() => fetchBrief(true)} disabled={loading}>
            {loading ? "Thinking…" : "Refresh"}
          </button>
        </header>
        {bErr && <p className="status err">{bErr}</p>}
        {!brief && !bErr && (
          <div style={{ display: "grid", gap: 8 }}>
            <div className="skeleton" style={{ width: "90%" }} />
            <div className="skeleton" style={{ width: "70%" }} />
          </div>
        )}
        {brief && (
          <>
            <p className="summary">{brief.summary}</p>
            {brief.moves.length > 0 && (
              <div className="moves">
                {brief.moves.map((m, i) => (
                  <div key={i} className="move">
                    <b>{m.title}</b>
                    <p>{m.why}</p>
                    {m.match_slug && (
                      <button className="btn sm" onClick={() => onMove({ slug: m.match_slug, discountPct: m.discount_pct, capUsd: m.cap_usd })}>
                        Set it up
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {brief.watch.length > 0 && (
              <ul className="watch">
                {brief.watch.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <div className="kpis">
        <div className="kpi">
          <span>Sales</span>
          <b>{$(t.sales)}</b>
        </div>
        <div className="kpi">
          <span>In your wallet</span>
          <b>{$(t.received)}</b>
        </div>
        <div className="kpi">
          <span>Set aside for refunds</span>
          <b>{$(t.held)}</b>
        </div>
        <div className="kpi">
          <span>Paid back to buyers</span>
          <b>{$(t.refunded)}</b>
        </div>
        <div className="kpi">
          <span>Buyers</span>
          <b>{t.fans}</b>
        </div>
      </div>

      <div className="two">
        <div className="panel">
          <h3>Your drops</h3>
          <DropList data={data} limit={6} />
        </div>
        <div className="panel">
          <h3>Activity</h3>
          {data.feed.length === 0 ? (
            <p className="empty">Sales and your manager&apos;s decisions show up here.</p>
          ) : (
            <ul className="timeline">
              {data.feed.slice(0, 12).map((f, i) => (
                <li key={i} className={f.kind === "sale" ? "sale" : ""}>
                  <a href={`/p/${f.drop}`}>
                    <time>
                      {new Date(f.at * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {f.match}
                    </time>
                    {f.kind === "sale" || f.kind === "pair" ? f.text : `Manager: ${f.kind === "rates" ? "moved the offers. " : f.kind === "final" ? "result final, refunds sent. " : ""}${f.kind === "final" ? "" : f.text}`}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function DropList({ data, limit }: { data: ManagerData; limit?: number }) {
  if (data.drops.length === 0) return <p className="empty">No drops yet. Your first one takes a minute.</p>;
  return (
    <>
      {data.drops.slice(0, limit ?? 100).map((d) => {
        const [ca, cb] = teamColors(d.meta.teamA, d.meta.teamB);
        const status =
          d.phase === "open" ? <span className="pill ac">Open</span> : d.phase === "live" ? <span className="pill live">Sale ended</span> : d.phase === "result" ? <span className="pill">Result in</span> : <span className="pill ok">Settled</span>;
        return (
          <a key={d.address} className="droprow" href={`/p/${d.address}`} style={{ ["--ca" as string]: ca, ["--cb" as string]: cb }}>
            <div className="th">{d.meta.image && <img src={d.meta.image} alt="" />}</div>
            <div>
              <b>{d.meta.product}</b>
              <span>
                {shortTeam(d.meta.teamA)} v {shortTeam(d.meta.teamB)} · {d.orders} {d.orders === 1 ? "order" : "orders"} {status}
                {d.byAgent && <span className="pill">Opened by your manager</span>}
                {!d.reconciled && <span className="pill live">Books don&apos;t match the chain</span>}
              </span>
            </div>
            <div className="r">
              <b>{$(d.sales)}</b>
              <span>
                {BigInt(d.refunded) > 0n
                  ? `${$(d.refunded)} paid back${d.extraSalesToBreakEven ? `, covered by ${d.extraSalesToBreakEven} ${d.extraSalesToBreakEven === 1 ? "sale" : "sales"}` : ""}`
                  : BigInt(d.held) > 0n
                    ? `${$(d.held)} set aside`
                    : d.phase === "settled"
                      ? "cost you nothing"
                      : "sales"}
              </span>
              {d.phase === "open" && <ShareDrop address={d.address} product={d.meta.product} />}
            </div>
          </a>
        );
      })}
    </>
  );
}

function Money({ data }: { data: ManagerData }) {
  const acct = useAccount()!;
  const [bal, setBal] = useState<bigint | null>(null);
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "working" | "ok" | "err"; text?: string; hash?: string }>({ kind: "idle" });
  const [retry, setRetry] = useState<Retry>(null);
  useEffect(() => {
    usdcBalance(acct.address).then(setBal).catch(() => {});
  }, [acct, status.kind]);
  async function send() {
    const n = Number(amt);
    if (!isAddress(to)) return setStatus({ kind: "err", text: "That isn't an Arc address." });
    if (!(n > 0) || (bal !== null && BigInt(Math.round(n * 1e6)) > bal)) return setStatus({ kind: "err", text: "Check the amount." });
    setStatus({ kind: "working", text: `Confirm with ${biometric()}…` });
    const finish = (hash: `0x${string}`) => {
      setStatus({ kind: "ok", text: "Sent.", hash });
      setAmt("");
    };
    try {
      finish(await sendUsdcWithCircle(acct, to, BigInt(Math.round(n * 1e6))));
    } catch (e) {
      const fail = (text: string) => setStatus({ kind: "err", text });
      if (handleTap(e, finish, fail, setRetry)) return setStatus({ kind: "idle" });
      fail((e as Error).message.split("\n")[0]);
    }
  }
  const t = data.totals;
  return (
    <>
      <Books books={data.books} />
      <div className="two">
        <div className="panel money">
          <span className="fine">Wallet balance</span>
          <div className="bal">{bal === null ? "…" : $(bal)}</div>
          <div className="walletline">
            <code>{acct.address}</code>
            <button
              className="link"
              onClick={() => {
                navigator.clipboard?.writeText(acct.address);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <h3 style={{ marginTop: 10 }}>Send USDC</h3>
          <label className="field">
            To <small>an Arc address, like your exchange deposit address (pick the Arc network there)</small>
            <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…" />
          </label>
          <label className="field">
            Amount
            <input type="number" min={0} step="0.01" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0.00" />
          </label>
          {retry ? (
            <button className="btn" onClick={retry}>
              Confirm with {biometric()}
            </button>
          ) : (
            <button className="btn" onClick={send} disabled={status.kind === "working"}>
              Send
            </button>
          )}
          {status.text && (
            <p className={`status ${status.kind === "err" ? "err" : status.kind === "ok" ? "ok" : ""}`}>
              {status.text}{" "}
              {status.hash && (
                <a href={explorerTx(status.hash)} target="_blank" rel="noreferrer">
                  Receipt
                </a>
              )}
            </p>
          )}
        </div>
        <div className="panel">
          <h3>Where your money is</h3>
          <div className="mini-row">
            <span>Total sales from drops</span>
            <b>{$(t.sales)}</b>
          </div>
          <div className="mini-row">
            <span>Paid to your wallet</span>
            <b>{$(t.received)}</b>
          </div>
          <div className="mini-row">
            <span>Set aside in live drops</span>
            <b>{$(t.held)}</b>
          </div>
          <div className="mini-row">
            <span>Refunded to winning fans</span>
            <b>{$(t.refunded)}</b>
          </div>
          <div className="mini-row">
            <span>Books checked against the chain</span>
            <b>{data.drops.every((d) => d.reconciled) ? `${data.drops.length} of ${data.drops.length} drops match to the cent` : "a drop does not match"}</b>
          </div>
          <div className="mini-row">
            <span>What drops cost you so far</span>
            <b>{Number(t.sales) > 0 ? `${((Number(t.refunded) / Number(t.sales)) * 100).toFixed(1)}% of sales` : "–"}</b>
          </div>
          <p className="fine" style={{ marginTop: 12 }}>
            Money set aside goes back to you after each match, minus any refunds. Nobody but your wallet can move what&apos;s in it.
          </p>
        </div>
      </div>
    </>
  );
}

function SignIn() {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [hasSaved, setHasSaved] = useState(false);
  const [bio, setBio] = useState("Face ID or fingerprint");
  const ready = usePasskeyReady();
  useEffect(() => {
    setHasSaved(!!savedCredential());
    setBio(biometric());
    if (circleEnabled()) preparePasskey().catch(() => {});
  }, []);
  async function go(mode: "register" | "login") {
    setErr("");
    setBusy(mode === "register" ? "Creating your wallet…" : "Signing in…");
    try {
      setAccount(await connectCircle(mode));
    } catch (e) {
      setErr(walletError(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="wrap signin">
      <div className="panel">
        <span className="orb" style={{ width: 54, height: 54 }} />
        <h1>Your sales manager</h1>
        <p className="muted">
          Sign in with {googleEnabled() ? `Google or ${bio}` : bio}. Your sales land in a Circle wallet that only you control, as USDC
          {NETWORK === "testnet" ? " (testnet)" : ""}.
        </p>
        {!circleEnabled() ? (
          <p className="status err">Wallets aren&apos;t configured on this deployment.</p>
        ) : (
          <>
            <GoogleButton className="btn google-btn" disabled={!!busy} />
            <button className="btn" disabled={!!busy || !ready} onClick={() => go(hasSaved ? "login" : "register")}>
              {!ready ? "Getting ready…" : hasSaved ? `Sign in with ${bio}` : googleEnabled() ? `Use ${bio} instead` : "Create my wallet"}
            </button>
            <button className="link" disabled={!!busy || !ready} onClick={() => go(hasSaved ? "register" : "login")}>
              {hasSaved ? "Create a new wallet instead" : "I already have one"}
            </button>
          </>
        )}
        {busy && <p className="status">{busy}</p>}
        {err && <p className="status err">{err}</p>}
      </div>
    </div>
  );
}
