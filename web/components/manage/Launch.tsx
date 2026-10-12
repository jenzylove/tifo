"use client";
// Make a drop in one short form. The seller says what they sell; the manager suggests the matches and the
// number of free spots; the seller only confirms. Everything that moves money is checked by the contract.
import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { keccak256, toBytes, type Address } from "viem";
import type { SmartAccount } from "viem/account-abstraction";
import type { Odds } from "@tifo/core";
import { biometric, createPromoWithCircle, openViaAccountWithCircle, type CreatePromoArgs } from "@/lib/circleWallet";
import { handleTap, type Retry } from "@/lib/tap";
import { shortTeam as short } from "@/lib/matches";
import { teamColors } from "@/lib/teams";
import ImageUpload from "./ImageUpload";

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
  discountPct?: number;
  capUsd?: number;
}

type Msg = { role: "user" | "assistant"; content: string };
type Kind = "digital" | "physical";
const FULL = 10_000;
const DRAW = 500; // on a draw every buyer gets 5% back as a thank you
const NAME_KEY = "tifo.seller.name";

// How much a league's fans tend to show up, for ranking suggestions. Unknown leagues still qualify.
const LEAGUE_WEIGHT: Record<string, number> = {
  "Champions League": 5, "Premier League": 5, "La Liga": 4, "Serie A": 4, Bundesliga: 4, "Europa League": 3,
  "Ligue 1": 3, "UEFA Nations League": 3, International: 3, MLS: 2,
};

/** The manager's picks: big leagues, kicking off soon but not too soon, and close enough that both sides buy. */
function suggest(matches: ApiMatch[]): { m: ApiMatch; why: string }[] {
  const now = Date.now();
  return matches
    .filter((m) => m.odds && Date.parse(m.kickoff) > now + 3 * 3600_000 && Date.parse(m.kickoff) < now + 6 * 86_400_000)
    .map((m) => {
      const gap = Math.abs(m.odds!.pA - m.odds!.pB);
      const days = (Date.parse(m.kickoff) - now) / 86_400_000;
      const score = (LEAGUE_WEIGHT[m.league] ?? 1) + (1 - gap) * 3 - days * 0.25;
      const why = gap < 0.2 ? "Close match, so fans on both sides will want in" : (LEAGUE_WEIGHT[m.league] ?? 1) >= 4 ? "Big match with fans on both sides" : "Kicks off soon, good for a quick drop";
      return { m, why, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function Launch({ account, sellerName, tifoAccount, prefill, onLaunched }: { account: SmartAccount; sellerName: string | null; tifoAccount?: Address; prefill?: Prefill; onLaunched: () => void }) {
  const [matches, setMatches] = useState<ApiMatch[] | null>(null);
  const [name, setName] = useState(sellerName ?? "");
  const [product, setProduct] = useState("");
  const [image, setImage] = useState("");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [kind, setKind] = useState<Kind>("digital");
  const [delivery, setDelivery] = useState("");
  const [contact, setContact] = useState("");
  const [slug, setSlug] = useState(prefill?.slug ?? "");
  const [spots, setSpots] = useState(2);
  const [wantCap, setWantCap] = useState<number | null>(prefill?.capUsd ?? null);
  const [browse, setBrowse] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "working" | "done" | "err"; text?: string; promo?: string }>({ kind: "idle" });
  const [retry, setRetry] = useState<Retry>(null);

  useEffect(() => {
    fetch("/api/matches").then((r) => r.json()).then(setMatches).catch(() => setMatches([]));
    if (!sellerName) setName(localStorage.getItem(NAME_KEY) ?? "");
  }, [sellerName]);
  useEffect(() => {
    if (prefill?.slug) setSlug(prefill.slug);
    if (prefill?.capUsd) setWantCap(prefill.capUsd);
  }, [prefill]);

  const priceUsd = Number(price);
  const costUsd = Math.max(0, Number(cost) || 0);
  const profitUsd = priceUsd > 0 ? priceUsd - costUsd : 0;
  // A budget suggested by the manager becomes a number of free spots once the price is known.
  useEffect(() => {
    if (wantCap && priceUsd > 0) {
      setSpots(Math.max(1, Math.min(20, Math.floor(wantCap / priceUsd))));
      setWantCap(null);
    }
  }, [wantCap, priceUsd]);

  const picks = useMemo(() => suggest(matches ?? []), [matches]);
  useEffect(() => {
    if (!slug && picks[0]) setSlug(picks[0].m.slug);
  }, [picks, slug]);
  const list = useMemo(() => {
    const q = query.toLowerCase();
    return (matches ?? []).filter((m) => m.odds && Date.parse(m.kickoff) > Date.now() + 45 * 60_000 && (!q || m.title.toLowerCase().includes(q) || m.league.toLowerCase().includes(q)));
  }, [matches, query]);
  const m = matches?.find((x) => x.slug === slug);
  const cap = priceUsd > 0 ? Math.round(spots * priceUsd * 100) / 100 : 0;
  const breakEven = profitUsd > 0 ? Math.ceil(cap / profitUsd) : null;
  const missing = !name.trim()
    ? "Add your shop name"
    : !product.trim()
      ? "Name the product"
      : !(priceUsd >= 1)
        ? "Set a price"
        : kind === "digital" && !delivery.trim()
          ? "Add what the buyer receives"
          : !m
            ? "Pick a match"
            : null;

  async function launch() {
    if (!m || missing) return;
    setStatus({ kind: "working", text: "Getting your drop ready…" });
    try {
      let sealed: string | undefined;
      if (kind === "digital") {
        const r = await fetch("/api/seal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: delivery }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        sealed = j.sealed;
      }
      localStorage.setItem(NAME_KEY, name.trim());
      const kickoff = Math.floor(Date.parse(m.kickoff) / 1000);
      const meta = JSON.stringify({
        slug: m.slug, league: m.league, teamA: m.teamA, teamB: m.teamB, kickoff: m.kickoff,
        shop: name.trim(), product: product.trim(), priceUsd, image: image || undefined,
        profitUsd: profitUsd > 0 ? profitUsd : undefined, delivery: sealed, contact: kind === "physical" && contact.trim() ? contact.trim() : undefined,
        shape: "free", baseRates: [FULL, FULL], minBps: FULL, maxBps: FULL, effectiveBps: 0,
      });
      setStatus({ kind: "working", text: `Confirm with ${biometric()}. Gas is covered.` });
      const args: NonNullable<CreatePromoArgs> = [
        keccak256(toBytes(m.slug)), BigInt(kickoff), BigInt(kickoff + 110 * 60), BigInt(Math.round(cap * 1e6)), FULL, FULL, FULL, FULL, 0, DRAW, meta,
      ];
      // With autopilot on, the drop opens through the seller's account so its sales land there and count toward the week.
      const { promo } = tifoAccount ? await openViaAccountWithCircle(account, tifoAccount, args) : await createPromoWithCircle(account, args);
      setStatus({ kind: "done", promo });
      onLaunched();
    } catch (e) {
      const fail = (text: string) => setStatus({ kind: "err", text });
      if (handleTap<{ promo: string }>(e, ({ promo }) => { setStatus({ kind: "done", promo }); onLaunched(); }, fail, setRetry)) return setStatus({ kind: "idle" });
      fail((e as Error).message.split("\n")[0]);
    }
  }

  if (status.kind === "done" && m)
    return (
      <Live
        url={`${location.origin}/p/${status.promo}`}
        post={`${product.trim()} is free if your team wins. ${spots} ${spots === 1 ? "spot" : "spots"} for ${short(m.teamA)} fans, ${spots} for ${short(m.teamB)} fans. Pick your side before kickoff.`}
        again={() => setStatus({ kind: "idle" })}
      />
    );

  return (
    <div className="maker">
      <section className="panel launch">
        <h3>What are you selling?</h3>
        {!sellerName && (
          <label className="field">
            Shop name
            <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Glow" />
          </label>
        )}
        <label className="field">
          Product
          <input className="input" value={product} maxLength={80} onChange={(e) => setProduct(e.target.value)} placeholder="Gua sha" />
        </label>
        <ImageUpload value={image} onChange={setImage} label="photo" />
        <div className="grid2">
          <label className="field">
            Price
            <span className="money-in">
              <i>$</i>
              <input className="input" type="number" min={1} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="5" />
            </span>
          </label>
          <label className="field">
            What one costs you
            <span className="money-in">
              <i>$</i>
              <input className="input" type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0" />
            </span>
            <small>Leave at 0 if it is digital</small>
          </label>
        </div>
        <div className="field">
          How they get it
          <div className="seg">
            <button className={kind === "digital" ? "on" : ""} onClick={() => setKind("digital")}>Download or link</button>
            <button className={kind === "physical" ? "on" : ""} onClick={() => setKind("physical")}>I deliver it</button>
          </div>
          {kind === "digital" ? (
            <input className="input" value={delivery} maxLength={600} onChange={(e) => setDelivery(e.target.value)} placeholder="Paste the download link. Only buyers see it." />
          ) : (
            <input className="input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Your WhatsApp number for delivery details" />
          )}
        </div>
      </section>

      <section className="panel launch">
        <h3>
          <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span className="orb" /> Your manager suggests
          </span>
        </h3>
        {matches === null && <div className="skeleton" />}
        <div className="picks">
          {picks.map(({ m: x, why }) => {
            const [ca, cb] = teamColors(x.teamA, x.teamB);
            return (
              <button key={x.slug} className={`pick ${x.slug === slug ? "on" : ""}`} onClick={() => setSlug(x.slug)}>
                <span className="dots" style={{ ["--ca" as string]: ca, ["--cb" as string]: cb }}>
                  <i />
                  <i />
                </span>
                <span className="t">
                  <b>
                    {short(x.teamA)} v {short(x.teamB)}
                  </b>
                  <small>
                    {x.league} · {when(x.kickoff)}
                  </small>
                  <em>{why}</em>
                </span>
              </button>
            );
          })}
        </div>
        {!browse ? (
          <button className="link" onClick={() => setBrowse(true)}>
            Choose a different match
          </button>
        ) : (
          <>
            <input className="input" placeholder="Search a team or league" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="matchlist">
              {list.slice(0, 40).map((x) => (
                <button key={x.slug} className={x.slug === slug ? "on" : ""} onClick={() => setSlug(x.slug)}>
                  <span>
                    {short(x.teamA)} v {short(x.teamB)}
                    <small>{x.league}</small>
                  </span>
                  <small>{when(x.kickoff)}</small>
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="panel launch">
        <h3>Free spots</h3>
        <div className="spots">
          <button aria-label="One fewer" onClick={() => setSpots((n) => Math.max(1, n - 1))} disabled={spots <= 1}>
            −
          </button>
          <div>
            <b>{spots}</b>
            <span>per side</span>
          </div>
          <button aria-label="One more" onClick={() => setSpots((n) => Math.min(20, n + 1))} disabled={spots >= 20}>
            +
          </button>
        </div>
        <p className="fine">The first {spots === 1 ? "buyer" : `${spots} buyers`} on each side get it free if their team wins.</p>
        {priceUsd >= 1 && (
          <div className="sum-lines">
            <div>
              <span>Most it can cost you</span>
              <b>${cap.toFixed(2)}</b>
            </div>
            {breakEven !== null && (
              <div>
                <span>Pays for itself after</span>
                <b>
                  {breakEven} extra {breakEven === 1 ? "sale" : "sales"}
                </b>
              </div>
            )}
          </div>
        )}
        {retry && (
          <button className="btn block" onClick={retry}>
            Confirm with {biometric()}
          </button>
        )}
        <button className="btn block" hidden={!!retry} disabled={!!missing || status.kind === "working"} onClick={launch}>
          {missing ?? `Get my link`}
        </button>
        {status.text && <p className={`status ${status.kind === "err" ? "err" : ""}`}>{status.text}</p>}
      </section>

      <details className="ask">
        <summary>Rather just chat? Ask your manager</summary>
        <ManagerChat
          seller={account.address}
          onProposal={(p) => {
            setSlug(p.slug);
            if (p.shop) setName(p.shop);
            if (p.product) setProduct(p.product);
            if (p.priceUsd) setPrice(String(p.priceUsd));
            if (p.image) setImage(p.image);
            setWantCap(p.capUsd);
          }}
        />
      </details>
    </div>
  );
}

/** The drop is live: the link, a QR for a counter or a story, and a post that is ready to send. */
function Live({ url, post, again }: { url: string; post: string; again: () => void }) {
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 440 }).then(setQr).catch(() => {});
  }, [url]);
  const copy = (what: string, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopied(what);
  };
  return (
    <div className="panel done">
      <b>Your drop is live.</b>
      <p className="fine">Send this link wherever you already sell. Your manager pays the winners after full time and shows you what the drop brought in.</p>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
        {qr && <img src={qr} alt="QR code for your drop" width={160} height={160} style={{ borderRadius: 8, background: "#fff" }} />}
        <div style={{ display: "grid", gap: 10, flex: "1 1 260px" }}>
          <code style={{ wordBreak: "break-all" }}>{url}</code>
          <p style={{ margin: 0 }}>{post}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn sm" onClick={() => copy("link", url)}>{copied === "link" ? "Link copied" : "Copy link"}</button>
            <button className="btn sm ghost" onClick={() => copy("post", `${post} ${url}`)}>{copied === "post" ? "Post copied" : "Copy post"}</button>
            <a className="btn sm ghost" href={`https://x.com/intent/post?text=${encodeURIComponent(post)}&url=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer">Post on X</a>
            {qr && <a className="btn sm ghost" href={qr} download="tifo-drop-qr.png">Save QR</a>}
            <a className="btn sm ghost" href={url} target="_blank" rel="noreferrer">Open the page</a>
          </div>
        </div>
      </div>
      <button className="link" onClick={again}>Set up another</button>
    </div>
  );
}

interface ChatProposal {
  slug: string;
  effectiveBps: number;
  capUsd: number;
  shop?: string;
  product?: string;
  priceUsd?: number;
  image?: string;
}

function ManagerChat({ seller, onProposal }: { seller: string; onProposal: (p: ChatProposal) => void }) {
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
      setMessages([...next, { role: "assistant", content: j.reply || (j.proposal ? "Done. I've filled in the drop on the left. Check it and get your link." : "…") }]);
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
            Ask it to plan the drop for you. For example: &ldquo;I sell a $20 template. Which match this weekend should I use? Keep my budget under $40.&rdquo; It
            fills in the form when you agree.
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
