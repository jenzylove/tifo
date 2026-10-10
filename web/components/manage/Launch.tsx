"use client";
// One screen to make a drop: the product, what the buyer receives, a real fixture with live odds, and the budget.
// Offers are computed with the same core math the agent and contract use. The manager can prefill all of it.
import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { keccak256, toBytes } from "viem";
import type { SmartAccount } from "viem/account-abstraction";
import { initialRates, type Odds } from "@tifo/core";
import type { Address } from "viem";
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
type Shape = "percent" | "free";
const MIN = 500, MAX = 6000, FULL = 10_000;
const DRAW = 500; // on a draw every buyer gets 5% back as a thank you
const NAME_KEY = "tifo.seller.name";

export default function Launch({ account, sellerName, tifoAccount, prefill, onLaunched }: { account: SmartAccount; sellerName: string | null; tifoAccount?: Address; prefill?: Prefill; onLaunched: () => void }) {
  const [matches, setMatches] = useState<ApiMatch[] | null>(null);
  const [name, setName] = useState(sellerName ?? "");
  const [product, setProduct] = useState("");
  const [image, setImage] = useState("");
  const [price, setPrice] = useState("");
  const [profit, setProfit] = useState("");
  const [kind, setKind] = useState<Kind>("digital");
  const [shape, setShape] = useState<Shape>("free");
  const [delivery, setDelivery] = useState("");
  const [contact, setContact] = useState("");
  const [slug, setSlug] = useState(prefill?.slug ?? "");
  const [discount, setDiscount] = useState(prefill?.discountPct ?? 10);
  const [cap, setCap] = useState(prefill?.capUsd ?? 25);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "working" | "done" | "err"; text?: string; promo?: string }>({ kind: "idle" });
  const [retry, setRetry] = useState<Retry>(null);

  useEffect(() => {
    fetch("/api/matches").then((r) => r.json()).then(setMatches).catch(() => setMatches([]));
    if (!sellerName) setName(localStorage.getItem(NAME_KEY) ?? "");
  }, [sellerName]);
  useEffect(() => {
    if (!prefill) return;
    if (prefill.slug) setSlug(prefill.slug);
    if (prefill.discountPct) setDiscount(Math.min(20, Math.max(3, Math.round(prefill.discountPct))));
    if (prefill.capUsd) setCap(Math.max(5, Math.round(prefill.capUsd)));
  }, [prefill]);

  const list = useMemo(() => {
    const ok = (matches ?? []).filter((m) => m.odds && Date.parse(m.kickoff) > Date.now() + 45 * 60_000);
    const q = query.toLowerCase();
    return ok.filter((m) => !q || m.title.toLowerCase().includes(q) || m.league.toLowerCase().includes(q));
  }, [matches, query]);
  const m = matches?.find((x) => x.slug === slug);
  const priceUsd = Number(price), profitUsd = Number(profit);
  const free = shape === "free";
  // "Free" gives a full refund to as many buyers per side as the budget covers. "Percent" spreads it over everyone.
  const rates = !m?.odds ? null : free ? ([FULL, FULL] as [number, number]) : (initialRates(m.odds, discount * 100, MIN, MAX).map(Number) as [number, number]);
  const [lo, hi] = free ? [FULL, FULL] : [MIN, MAX];
  const spots = priceUsd > 0 ? Math.floor(cap / priceUsd) : 0;
  const colors = m ? teamColors(m.teamA, m.teamB) : ["#999", "#666"];

  // The numbers a seller decides on: what the promo costs on an average sale, and how many extra sales pay for the budget.
  const costPerSale = priceUsd > 0 ? (priceUsd * discount) / 100 : 0;
  const tooThin = !free && profitUsd > 0 && costPerSale >= profitUsd;
  const breakEven = profitUsd > 0 ? Math.ceil(cap / profitUsd) : null;
  const missing =
    !name.trim() ? "Add your name" : !product.trim() ? "Name the product" : !(priceUsd >= 1) ? "Set a price" : !m || !rates ? "Pick a match" : kind === "digital" && !delivery.trim() ? "Add what the buyer receives" : tooThin ? "Lower the discount" : free && spots < 1 ? "Raise the budget to cover one product" : null;

  async function launch() {
    if (!m || !rates || missing) return;
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
        shape, baseRates: rates, minBps: lo, maxBps: hi, effectiveBps: free ? 0 : discount * 100,
      });
      setStatus({ kind: "working", text: `Confirm with ${biometric()}. Gas is covered.` });
      const args: NonNullable<CreatePromoArgs> = [
        keccak256(toBytes(m.slug)), BigInt(kickoff), BigInt(kickoff + 110 * 60), BigInt(Math.round(cap * 1e6)), lo, hi, rates[0], rates[1], 0, DRAW, meta,
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

  if (status.kind === "done" && m && rates)
    return (
      <Live
        url={`${location.origin}/p/${status.promo}`}
        post={
          free
            ? `${product.trim()} is free if your team wins. ${spots} ${spots === 1 ? "spot" : "spots"} for ${short(m.teamA)} fans, ${spots} for ${short(m.teamB)} fans. Pick your side before kickoff.`
            : `${product.trim()}: ${rates[0] / 100}% back if ${short(m.teamA)} win, ${rates[1] / 100}% back if ${short(m.teamB)} win. Pick your side before kickoff.`
        }
        again={() => setStatus({ kind: "idle" })}
      />
    );

  return (
    <div className="two" style={{ marginTop: 0 }}>
      <div className="panel launch">
        <h3>New match drop</h3>
        <div className="grid2">
          <label className="field">
            Your name <small>as buyers know you</small>
            <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Dollars Glow" />
          </label>
          <label className="field">
            Product
            <input className="input" value={product} maxLength={80} onChange={(e) => setProduct(e.target.value)} placeholder="Notion budget template" />
          </label>
        </div>
        <ImageUpload value={image} onChange={setImage} label="photo" />
        <div className="grid2">
          <label className="field">
            Price <small>in USDC, what the buyer pays</small>
            <input className="input" type="number" min={1} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="20" />
          </label>
          <label className="field">
            Your profit per sale <small>so we can tell you when the drop pays for itself</small>
            <input className="input" type="number" min={0} step="0.01" value={profit} onChange={(e) => setProfit(e.target.value)} placeholder="20" />
          </label>
        </div>
        <div>
          <p className="fine" style={{ marginBottom: 6 }}>What the buyer gets</p>
          <div className="chips">
            <button className={`chip ${kind === "digital" ? "on" : ""}`} onClick={() => setKind("digital")}>
              Digital <small>opens right after they pay</small>
            </button>
            <button className={`chip ${kind === "physical" ? "on" : ""}`} onClick={() => setKind("physical")}>
              I deliver it myself
            </button>
          </div>
          {kind === "digital" ? (
            <textarea className="input" rows={2} maxLength={600} value={delivery} onChange={(e) => setDelivery(e.target.value)} placeholder="The download link, access code or note. Only buyers who paid can open it." style={{ marginTop: 8, width: "100%" }} />
          ) : (
            <input className="input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="WhatsApp number or a link where buyers send delivery details" style={{ marginTop: 8, width: "100%" }} />
          )}
        </div>
        <div>
          <p className="fine" style={{ marginBottom: 6 }}>Match</p>
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
        <div>
          <p className="fine" style={{ marginBottom: 6 }}>The offer</p>
          <div className="chips">
            <button className={`chip ${free ? "on" : ""}`} onClick={() => setShape("free")}>
              Free if your team wins <small>for the first buyers on each side</small>
            </button>
            <button className={`chip ${free ? "" : "on"}`} onClick={() => setShape("percent")}>
              Money back for everyone <small>a smaller % for every buyer</small>
            </button>
          </div>
        </div>
        <div className="grid2">
          {free ? (
            <div className="field">
              Free spots <small>your budget divided by your price</small>
              <b style={{ fontSize: 22 }}>{spots} per side</b>
            </div>
          ) : (
            <label className="field">
              Average discount <small>{discount}% across all fans</small>
              <input type="range" min={3} max={20} value={discount} onChange={(e) => setDiscount(Number(e.target.value))} />
            </label>
          )}
          <label className="field">
            Budget <small>the most this drop can cost you, in USDC</small>
            <input className="input" type="number" min={5} max={5000} value={cap} onChange={(e) => setCap(Math.max(5, Number(e.target.value)))} />
          </label>
        </div>
        {m && rates && priceUsd >= 1 && (
          <div className="quote">
            <div className="sides">
              {[0, 1].map((s) => (
                <div key={s} className="side" style={{ ["--c" as string]: colors[s] }}>
                  <span className="t">{short(s ? m.teamB : m.teamA)} fans</span>
                  <span className="pct">{free ? "Free" : `${rates[s] / 100}%`}</span>
                  <span className="back">
                    {free ? `if they win · first ${spots} ${spots === 1 ? "buyer" : "buyers"}` : `back if they win · $${((priceUsd * rates[s]) / 10_000).toFixed(2)} per item`}
                  </span>
                </div>
              ))}
            </div>
            <p className="fine">
              This drop can never cost you more than <b>${cap}</b>, whoever wins. {free ? "Once the free spots on a side are taken, buyers on that side pay full price with no refund. " : ""}
              On a draw every buyer gets {DRAW / 100}% back as a thank you. Each sale goes to your wallet straight away, except the part set aside for refunds.
            </p>
            {tooThin ? (
              <p className="status err">
                At {discount}% the promo gives away about ${costPerSale.toFixed(2)} a sale, and you make ${profitUsd.toFixed(2)}. Lower the discount so you still
                earn on every sale.
              </p>
            ) : (
              breakEven !== null && (
                <p className="fine">
                  <b>
                    It pays for itself at {breakEven} extra {breakEven === 1 ? "sale" : "sales"}.
                  </b>{" "}
                  That is the full ${cap} budget divided by your ${profitUsd.toFixed(2)} profit per sale.
                </p>
              )
            )}
          </div>
        )}
        {retry && (
          <button className="btn" onClick={retry}>
            Confirm with {biometric()}
          </button>
        )}
        <button className="btn" hidden={!!retry} disabled={!!missing || status.kind === "working"} onClick={launch}>
          {missing ?? `Get my link for ${short(m!.teamA)} v ${short(m!.teamB)}`}
        </button>
        {status.text && <p className={`status ${status.kind === "err" ? "err" : ""}`}>{status.text}</p>}
      </div>
      <ManagerChat
        seller={account.address}
        onProposal={(p) => {
          setSlug(p.slug);
          setDiscount(Math.min(20, Math.max(3, Math.round(p.effectiveBps / 100))));
          setCap(p.capUsd);
          if (p.shop) setName(p.shop);
          if (p.product) setProduct(p.product);
          if (p.priceUsd) setPrice(String(p.priceUsd));
          if (p.image) setImage(p.image);
        }}
      />
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
      <p className="fine">Send this link wherever you already sell. Your manager balances the offers as orders come in and pays the winners after full time.</p>
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
