"use client";
// Set up a match drop: product from the catalog, a real fixture with live odds, the shop's discount and cap.
// Offers are computed with the same core math the agent and contract use. The manager can prefill all of it.
import { useEffect, useMemo, useState } from "react";
import { keccak256, toBytes } from "viem";
import type { SmartAccount } from "viem/account-abstraction";
import { initialRates, type Odds } from "@tifo/core";
import { createPromoWithCircle } from "@/lib/circleWallet";
import type { Shop } from "@/lib/shops";
import { shortTeam as short } from "@/lib/matches";
import { teamColors } from "@/lib/teams";

interface ApiMatch {
  slug: string;
  league: string;
  title: string;
  teamA: string;
  teamB: string;
  kickoff: string;
  odds: Odds | null;
}

export interface Prefill {
  slug?: string;
  productId?: string;
  discountPct?: number;
  capUsd?: number;
}

type Msg = { role: "user" | "assistant"; content: string };
const MIN = 500, MAX = 6000;

export default function Launch({ account, shop, prefill, onLaunched }: { account: SmartAccount; shop: Shop; prefill?: Prefill; onLaunched: () => void }) {
  const products = shop.profile.products;
  const [matches, setMatches] = useState<ApiMatch[] | null>(null);
  const [slug, setSlug] = useState(prefill?.slug ?? "");
  const [productId, setProductId] = useState(prefill?.productId ?? products[0]?.id ?? "");
  const [discount, setDiscount] = useState(prefill?.discountPct ?? 10);
  const [cap, setCap] = useState(prefill?.capUsd ?? 25);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "working" | "done" | "err"; text?: string; promo?: string }>({ kind: "idle" });

  useEffect(() => {
    fetch("/api/matches").then((r) => r.json()).then(setMatches).catch(() => setMatches([]));
  }, []);
  useEffect(() => {
    if (!prefill) return;
    if (prefill.slug) setSlug(prefill.slug);
    if (prefill.productId) setProductId(prefill.productId);
    if (prefill.discountPct) setDiscount(Math.min(20, Math.max(3, Math.round(prefill.discountPct))));
    if (prefill.capUsd) setCap(Math.max(5, Math.round(prefill.capUsd)));
  }, [prefill]);

  const teams = (shop.profile.teams ?? []).map((t) => t.toLowerCase());
  const list = useMemo(() => {
    const ok = (matches ?? []).filter((m) => m.odds && Date.parse(m.kickoff) > Date.now() + 45 * 60_000);
    const q = query.toLowerCase();
    const hit = (m: ApiMatch) => teams.some((t) => m.title.toLowerCase().includes(t));
    return ok.filter((m) => !q || m.title.toLowerCase().includes(q) || m.league.toLowerCase().includes(q)).sort((a, b) => Number(hit(b)) - Number(hit(a)));
  }, [matches, query, teams]);
  const m = matches?.find((x) => x.slug === slug);
  const product = products.find((x) => x.id === productId);
  const rates = m?.odds ? (initialRates(m.odds, discount * 100, MIN, MAX).map(Number) as [number, number]) : null;
  const colors = m ? teamColors(m.teamA, m.teamB) : ["#999", "#666"];

  async function launch() {
    if (!m || !rates || !product) return;
    setStatus({ kind: "working", text: "Confirm with your fingerprint. Gas is covered." });
    try {
      const kickoff = Math.floor(Date.parse(m.kickoff) / 1000);
      const meta = JSON.stringify({
        slug: m.slug, league: m.league, teamA: m.teamA, teamB: m.teamB, kickoff: m.kickoff,
        shop: shop.profile.name, handle: shop.handle, productId: product.id, product: product.name, priceUsd: product.priceUsd,
        image: product.image, description: product.description, link: `/s/${shop.handle}`,
        baseRates: rates, minBps: MIN, maxBps: MAX, effectiveBps: discount * 100,
      });
      const { promo } = await createPromoWithCircle(account, [
        keccak256(toBytes(m.slug)), BigInt(kickoff), BigInt(kickoff + 110 * 60), BigInt(Math.round(cap * 1e6)), MIN, MAX, rates[0], rates[1], meta,
      ]);
      setStatus({ kind: "done", promo });
      onLaunched();
    } catch (e) {
      setStatus({ kind: "err", text: (e as Error).message.split("\n")[0] });
    }
  }

  if (status.kind === "done")
    return (
      <div className="panel done">
        <b>Your drop is live.</b>
        <p className="fine">Share the link with your buyers on WhatsApp, Instagram or X. Your manager will balance the offers as orders come in and settle after full time.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a className="btn sm" href={`/p/${status.promo}`} target="_blank" rel="noreferrer">Open the drop page</a>
          <button className="btn sm ghost" onClick={() => navigator.clipboard?.writeText(`${location.origin}/p/${status.promo}`)}>Copy link</button>
          <button className="btn sm ghost" onClick={() => setStatus({ kind: "idle" })}>Set up another</button>
        </div>
      </div>
    );

  return (
    <div className="two" style={{ marginTop: 0 }}>
      <div className="panel launch">
        <h3>New match drop</h3>
        <div>
          <p className="fine" style={{ marginBottom: 6 }}>Product</p>
          <div className="chips">
            {products.map((x) => (
              <button key={x.id} className={`chip ${x.id === productId ? "on" : ""}`} onClick={() => setProductId(x.id)}>
                {x.name}
                <small>${x.priceUsd.toFixed(2)}</small>
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="fine" style={{ marginBottom: 6 }}>Match {teams.length > 0 && "· your buyers' clubs first"}</p>
          <input className="input" placeholder="Search a team or league" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginBottom: 8 }} />
          <div className="matchlist">
            {matches === null && <div className="skeleton" />}
            {matches !== null && list.length === 0 && <p className="fine">No matches with live odds found. Try another search.</p>}
            {list.slice(0, 40).map((x) => (
              <button key={x.slug} className={x.slug === slug ? "on" : ""} onClick={() => setSlug(x.slug)}>
                <span>
                  {short(x.teamA)} v {short(x.teamB)}
                  <small>{x.league}</small>
                </span>
                <small>{new Date(x.kickoff).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small>
              </button>
            ))}
          </div>
        </div>
        <div className="grid2">
          <label className="field">
            Average discount <small>{discount}% across all fans</small>
            <input type="range" min={3} max={20} value={discount} onChange={(e) => setDiscount(Number(e.target.value))} />
          </label>
          <label className="field">
            Most you&apos;ll ever owe <small>in USDC, whoever wins</small>
            <input type="number" min={5} max={5000} value={cap} onChange={(e) => setCap(Math.max(5, Number(e.target.value)))} />
          </label>
        </div>
        {m && rates && product && (
          <div className="quote">
            <div className="sides">
              {[0, 1].map((s) => (
                <div key={s} className="side" style={{ ["--c" as string]: colors[s] }}>
                  <span className="t">{short(s ? m.teamB : m.teamA)} fans</span>
                  <span className="pct">{rates[s] / 100}%</span>
                  <span className="back">back if they win · ${((product.priceUsd * rates[s]) / 10_000).toFixed(2)} per item</span>
                </div>
              ))}
            </div>
            <p className="fine">
              Draw: no rebate. Each sale goes to your wallet straight away, except a small part set aside for refunds. You never owe more than ${cap}.
            </p>
          </div>
        )}
        <button className="btn" disabled={!m || !rates || !product || status.kind === "working"} onClick={launch}>
          {m ? `Launch ${product?.name ?? "drop"} on ${short(m.teamA)} v ${short(m.teamB)}` : "Pick a match"}
        </button>
        {status.text && <p className={`status ${status.kind === "err" ? "err" : ""}`}>{status.text}</p>}
      </div>
      <ManagerChat seller={account.address} onProposal={(p) => { setSlug(p.slug); if (p.productId) setProductId(p.productId); setDiscount(Math.round(p.effectiveBps / 100)); setCap(p.capUsd); }} />
    </div>
  );
}

function ManagerChat({ seller, onProposal }: { seller: string; onProposal: (p: { slug: string; productId?: string; effectiveBps: number; capUsd: number }) => void }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || busy) return;
    const next: Msg[] = [...messages, { role: "user", content: input.trim() }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: next, seller }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setMessages([...next, { role: "assistant", content: j.reply || (j.proposal ? "Done. I've filled in the drop on the left. Check it and launch." : "…") }]);
      if (j.proposal) onProposal(j.proposal);
    } catch (err) {
      setMessages([...next, { role: "assistant", content: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="panel chat">
      <h3>
        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="orb" /> Ask your manager
        </span>
      </h3>
      <div className="log">
        {messages.length === 0 && (
          <p className="fine">
            Ask it to plan the drop for you. For example: &ldquo;Which match this weekend is best for my jerseys? Keep my worst case under $40.&rdquo; It will
            fill in the form when you agree.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>{m.content}</div>
        ))}
        {busy && <div className="msg assistant pending">Checking fixtures and odds…</div>}
      </div>
      <form onSubmit={send} className="composer">
        <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Message your manager…" disabled={busy} />
        <button className="btn sm" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}
