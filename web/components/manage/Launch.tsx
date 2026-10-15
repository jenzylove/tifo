"use client";
// Make a drop. The seller says what they sell (or starts from a post they already made); their agent plans the drop:
// the match, how much comes back, whether it balances the offer and waits for a few buyers, and why. The seller posts it
// or changes what they like. Everything that moves money is checked by the contract.
import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { isAddress, keccak256, toBytes, type Address } from "viem";
import type { SmartAccount } from "viem/account-abstraction";
import type { Odds } from "@tifo/core";
import { biometric, createAccountAndOpenWithCircle, openViaAccountWithCircle, type CreatePromoArgs } from "@/lib/circleWallet";
import { handleTap, type Retry } from "@/lib/tap";
import { shortTeam as short } from "@/lib/matches";
import { teamColors } from "@/lib/teams";
import { FULL } from "@/lib/offer";
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
  backBps?: number; // when the manager suggests how much comes back
}

interface Plan {
  slug: string;
  backPct: number;
  balance: boolean;
  minBuyers: number;
  refFriends?: number;
  reason: string;
  byModel: boolean;
}

type Msg = { role: "user" | "assistant"; content: string };
type Kind = "digital" | "physical" | "booking";
const DRAW = 500; // on a draw every buyer gets 5% back as a thank you (shown to buyers in the small print)
const NAME_KEY = "tifo.seller.name";
const MAX_STOCK = 500;
const REACH = [0, 3, 5, 10]; // when the offer switches on: from the first sale, or once this many people bought
const REFS = [0, 2, 3, 5]; // referrals: off, or a buyer's order is free once this many friends buy through their link
const SHARES = [25, 50, 100]; // the usual offers; any whole percent from 10 to 100 is allowed
const EARNED_SHARE_BPS = 1_000; // the weekly limit also grows by 10% of what the seller's drops sold the week before
const HOLD_SECS = 7 * 86_400; // physical products: payment waits for delivery (see TifoPromo.markSent)

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const offer = (pct: number) => (pct >= 100 ? "Free if your team wins" : `${pct}% back if your team wins`);

export default function Launch({ account, sellerName, tifoAccount, prefill, onLaunched }: { account: SmartAccount; sellerName: string | null; tifoAccount?: Address; prefill?: Prefill; onLaunched: () => void }) {
  const [matches, setMatches] = useState<ApiMatch[] | null>(null);
  const [name, setName] = useState(sellerName ?? "");
  const [product, setProduct] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState("");
  const [price, setPrice] = useState("");
  const [priceNote, setPriceNote] = useState("");
  const [cost, setCost] = useState("");
  const [kind, setKind] = useState<Kind>("digital");
  const [delivery, setDelivery] = useState("");
  const [contact, setContact] = useState("");
  const [slots, setSlots] = useState<string[]>([""]); // datetime-local values, for a bookable service
  const [fill, setFill] = useState({ day: "", from: "10:00", to: "14:00", every: "30" }); // shortcut: fill a day with times
  const [stock, setStock] = useState("10"); // how many the seller has to sell; this caps the most the drop can cost
  // The plan: the agent fills these in, the seller may change any of them.
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planErr, setPlanErr] = useState("");
  const [editing, setEditing] = useState(false);
  const [slug, setSlug] = useState(prefill?.slug ?? "");
  const [backPct, setBackPct] = useState(prefill?.backBps ? Math.round(prefill.backBps / 100) : 50);
  const [custom, setCustom] = useState(false);
  const [balance, setBalance] = useState(true); // the agent may move each side's offer between half and the full offer
  const [minBuyers, setMinBuyers] = useState(0); // the offer only pays out once this many people bought; 0 is from the first sale
  const [refs, setRefs] = useState(0); // a buyer who brings this many friends gets their order free; 0 is off
  const [browse, setBrowse] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "working" | "done" | "err"; text?: string; promo?: string }>({ kind: "idle" });
  const [retry, setRetry] = useState<Retry>(null);
  // A first drop also gives the agent its rule: how much its drops may cost in a week, and where the money goes.
  const [weekly, setWeekly] = useState("");
  const [payoutMode, setPayoutMode] = useState<"this" | "other">("this");
  const [payoutTo, setPayoutTo] = useState("");

  useEffect(() => {
    fetch("/api/matches").then((r) => r.json()).then(setMatches).catch(() => setMatches([]));
    if (!sellerName) setName(localStorage.getItem(NAME_KEY) ?? "");
  }, [sellerName]);
  useEffect(() => {
    if (prefill?.slug) setSlug(prefill.slug);
    if (prefill?.backBps) setBackPct(Math.round(prefill.backBps / 100));
  }, [prefill]);

  const priceUsd = Number(price);
  const costUsd = Math.max(0, Number(cost) || 0);
  const profitUsd = priceUsd > 0 ? priceUsd - costUsd : 0;
  const slotTimes = slots.filter((x) => x && Date.parse(x) > Date.now());
  // A bookable service has exactly as many units as times on offer.
  const units = kind === "booking" ? slotTimes.length : Math.max(0, Math.min(MAX_STOCK, Math.floor(Number(stock) || 0)));
  const reach = units > 0 && minBuyers > units ? 0 : minBuyers; // cannot ask for more buyers than there is to sell
  const tier = Math.min(100, Math.max(10, Math.round(backPct))) * 100;
  const refNeeded = kind === "physical" ? 0 : refs; // shipped orders wait for delivery, so referrals are for digital and bookings
  const low = balance ? Math.max(500, Math.floor(tier / 2 / 500) * 500) : tier; // the lowest the agent may take a side's offer

  const list = useMemo(() => {
    const q = query.toLowerCase();
    return (matches ?? []).filter((m) => m.odds && Date.parse(m.kickoff) > Date.now() + 45 * 60_000 && (!q || m.title.toLowerCase().includes(q) || m.league.toLowerCase().includes(q)));
  }, [matches, query]);
  const m = matches?.find((x) => x.slug === slug);
  // Every buyer gets the same share back. The worst case is all the stock selling to the side that wins.
  const cap = priceUsd > 0 ? Math.round(((units * priceUsd * tier) / FULL) * 100) / 100 : 0;
  // What it usually costs: buyers split between the two teams, one side wins, a draw pays only the small thank you.
  const odds = m?.odds ?? null;
  const usual = odds && priceUsd > 0 ? (units * priceUsd * (tier / FULL) * (odds.pA + odds.pB)) / 2 : null;
  const likePct = usual !== null && units > 0 ? Math.round((usual / (units * priceUsd)) * 100) : null;
  const breakEven = profitUsd > 0 ? Math.ceil(cap / profitUsd) : null;
  // Room for this drop and one more like it, unless the seller says otherwise.
  const weeklyDefault = Math.max(10, Math.ceil(cap * 2));
  const weeklyUsd = Math.max(0, Number(weekly) || weeklyDefault);
  const payout = (payoutMode === "this" ? account.address : payoutTo.trim()) as Address;

  const productMissing = !name.trim()
    ? "Add your shop name"
    : !product.trim()
      ? "Name the product"
      : !(priceUsd >= 1)
        ? "Set a price of at least $1"
        : kind === "booking" && units < 1
          ? "Add at least one time"
          : kind !== "digital" && !contact.trim()
            ? "Add your WhatsApp or Instagram"
            : !(units >= 1)
              ? "Say how many you have"
              : kind === "digital" && !delivery.trim()
                ? "Add what the buyer receives"
                : null;
  const missing =
    productMissing ??
    (!m ? "Pick a match" : !(backPct >= 10 && backPct <= 100) ? "Set between 10% and 100% back" : !tifoAccount && payoutMode === "other" && !isAddress(payout) ? "Add the wallet your money goes to" : null);

  /** Ask the agent for the whole plan. */
  async function askAgent() {
    if (productMissing) return;
    setPlanning(true);
    setPlanErr("");
    try {
      const r = await fetch("/api/plan-drop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ product: product.trim(), priceUsd, units, kind, profitUsd: costUsd > 0 ? profitUsd : null, shop: name.trim() || null }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      const p = j as Plan;
      setPlan(p);
      setSlug(p.slug);
      setBackPct(p.backPct);
      setCustom(!SHARES.includes(p.backPct));
      setBalance(p.balance);
      setMinBuyers(p.minBuyers);
      setRefs(p.refFriends ?? 0);
      setEditing(false);
    } catch (e) {
      setPlanErr((e as Error).message);
    } finally {
      setPlanning(false);
    }
  }

  async function launch() {
    if (!m || missing) return;
    setStatus({ kind: "working", text: "Getting your drop ready…" });
    try {
      let sealed: string | undefined;
      if (kind === "digital") {
        const r = await fetch("/api/seal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: delivery, owner: account.address }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        sealed = j.sealed;
      }
      localStorage.setItem(NAME_KEY, name.trim());
      const kickoff = Math.floor(Date.parse(m.kickoff) / 1000);
      const meta = JSON.stringify({
        slug: m.slug, league: m.league, teamA: m.teamA, teamB: m.teamB, kickoff: m.kickoff,
        shop: name.trim(), product: product.trim(), priceUsd, image: image || undefined, description: description.trim() || undefined,
        profitUsd: profitUsd > 0 ? profitUsd : undefined, delivery: sealed, contact: kind !== "digital" && contact.trim() ? contact.trim() : undefined,
        slots: kind === "booking" ? slotTimes.map((x) => new Date(x).toISOString()).sort() : undefined,
        shape: tier >= FULL ? "free" : "back", backBps: tier, stock: units, baseRates: [tier, tier], minBps: low, maxBps: tier, effectiveBps: tier >= FULL ? 0 : tier,
        minBuyers: reach || undefined, refNeeded: refNeeded || undefined, reason: plan?.reason || undefined,
      });
      setStatus({ kind: "working", text: `Confirm with ${biometric()}. Gas is covered.` });
      const args: NonNullable<CreatePromoArgs> = [
        keccak256(toBytes(m.slug)), BigInt(kickoff), BigInt(kickoff + 110 * 60), BigInt(Math.round(cap * 1e6)), low, tier, tier, tier, 0, DRAW, kind === "physical" ? HOLD_SECS : 0, reach, BigInt(Math.round(priceUsd * 1e6)), refNeeded, meta,
      ];
      // Every drop opens through the seller's account, so the agent can pay winners and send the seller their money.
      // A first drop creates that account in the same confirmation.
      const limit = BigInt(Math.round(Math.max(weeklyUsd, cap) * 1e6));
      const { promo } = tifoAccount
        ? await openViaAccountWithCircle(account, tifoAccount, args)
        : await createAccountAndOpenWithCircle(account, EARNED_SHARE_BPS, limit, limit, payout, args);
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
        post={`${product.trim()}: ${tier >= FULL ? "it's free" : `${tier / 100}% back`} if your team wins. ${short(m.teamA)} or ${short(m.teamB)}? Pick your side before the sale ends. Only ${units} available.`}
        again={() => {
          setStatus({ kind: "idle" });
          setPlan(null);
        }}
      />
    );

  const [ca, cb] = m ? teamColors(m.teamA, m.teamB) : ["#ccc", "#ccc"];
  return (
    <div className="maker">
      <section className="panel launch">
        <h3>What are you selling?</h3>
        <FromPost
          onFill={(x) => {
            if (x.shop && !sellerName && !name.trim()) setName(x.shop);
            if (x.product) setProduct(x.product);
            if (x.description) setDescription(x.description);
            if (x.priceUsd) setPrice(String(x.priceUsd));
            setPriceNote(x.priceNote ?? "");
            if (x.kind) setKind(x.kind);
            if (x.stock) setStock(String(x.stock));
            if (x.image) setImage(x.image);
            setPlan(null);
          }}
        />
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
            {priceNote && <small>{priceNote}</small>}
          </label>
          <label className="field" hidden={kind === "booking"}>
            How many you have
            <input className="input" type="number" min={1} max={MAX_STOCK} step={1} value={stock} onChange={(e) => setStock(e.target.value)} placeholder="10" />
          </label>
        </div>
        <div className="field">
          How they get it
          <div className="seg three">
            <button className={kind === "digital" ? "on" : ""} onClick={() => setKind("digital")}>Download or link</button>
            <button className={kind === "physical" ? "on" : ""} onClick={() => setKind("physical")}>I deliver it</button>
            <button className={kind === "booking" ? "on" : ""} onClick={() => setKind("booking")}>Book a time</button>
          </div>
          {kind === "booking" ? (
            <>
              <small>A consultation, an appointment, a lesson. Add the times you are free. Each time can be booked once.</small>
              {slots.map((v, i) => (
                <div key={i} style={{ display: "flex", gap: 8 }}>
                  <input className="input" type="datetime-local" value={v} onChange={(e) => setSlots((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))} />
                  {slots.length > 1 && (
                    <button className="btn sm ghost" aria-label="Remove this time" onClick={() => setSlots((xs) => xs.filter((_, j) => j !== i))}>
                      ×
                    </button>
                  )}
                </div>
              ))}
              {slots.length < 30 && (
                <button className="link fine" style={{ justifySelf: "start" }} onClick={() => setSlots((xs) => [...xs, ""])}>
                  + Add another time
                </button>
              )}
              <details className="fill-day">
                <summary className="fine">Or fill a whole day at once</summary>
                <div className="fill-row">
                  <input className="input" type="date" value={fill.day} onChange={(e) => setFill((f) => ({ ...f, day: e.target.value }))} aria-label="Day" />
                  <input className="input" type="time" value={fill.from} onChange={(e) => setFill((f) => ({ ...f, from: e.target.value }))} aria-label="From" />
                  <input className="input" type="time" value={fill.to} onChange={(e) => setFill((f) => ({ ...f, to: e.target.value }))} aria-label="To" />
                  <select className="input" value={fill.every} onChange={(e) => setFill((f) => ({ ...f, every: e.target.value }))} aria-label="Each session">
                    {["15", "20", "30", "45", "60", "90", "120"].map((x) => (
                      <option key={x} value={x}>
                        {x} min each
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  className="btn sm ghost"
                  disabled={!fill.day}
                  onClick={() => {
                    const [fh, fm] = fill.from.split(":").map(Number);
                    const [th, tm] = fill.to.split(":").map(Number);
                    const step = Number(fill.every);
                    const out: string[] = [];
                    for (let t = fh * 60 + fm; t + step <= th * 60 + tm && out.length < 30; t += step)
                      out.push(`${fill.day}T${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
                    // Keep times already added, add the new ones, no duplicates, in order, at most 30.
                    setSlots((xs) => [...new Set([...xs.filter(Boolean), ...out])].sort().slice(0, 30));
                  }}
                >
                  Add these times
                </button>
              </details>
            </>
          ) : kind === "digital" ? (
            <input className="input" value={delivery} maxLength={600} onChange={(e) => setDelivery(e.target.value)} placeholder="Paste the download link or code. Only buyers see it." />
          ) : (
            <small>Buyers add their delivery address after paying. Their payment waits in the drop until they have it.</small>
          )}
          {kind !== "digital" && (
            <input className="input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Your WhatsApp number or @instagram, so buyers can reach you" />
          )}
        </div>
        {!plan && (
          <>
            <button className="btn block" disabled={!!productMissing || planning} onClick={askAgent}>
              {productMissing ?? (planning ? "Your agent is planning…" : "Let my agent plan it")}
            </button>
            {planErr && <p className="status err">{planErr}</p>}
          </>
        )}
      </section>

      {plan && m && (
        <section className="panel launch plan-card" style={{ ["--ca" as string]: ca, ["--cb" as string]: cb }}>
          <h3>
            <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span className="orb" /> Your agent&apos;s plan
            </span>
          </h3>
          <div className="plan-offer">
            <b>{offer(backPct)}</b>
            <span>
              {short(m.teamA)} v {short(m.teamB)} · sale ends {when(m.kickoff)}
            </span>
          </div>
          <p className="plan-why">{plan.reason}</p>
          <ul className="plan-terms">
            <li>{balance ? `If more fans pick one team, I lower that team's offer for new buyers (never below ${low / 100}%), so your cost stays even.` : "Every buyer gets the same offer."}</li>
            <li>{reach ? `The offer only pays out once ${reach} people buy, so buyers will share your link.` : "The offer works from the first sale."}</li>
            {refNeeded > 0 && <li>Referrals are on: a buyer who brings {refNeeded} friends gets their order free after the match. I set aside a share of each friend&apos;s payment for it, so the extra sales pay for it.</li>}
            <li>I pay winning fans back after the match and send you your money. Every move is written on chain with my reason.</li>
          </ul>
          <div className="sum-lines">
            <div>
              <span>Most it can cost you</span>
              <b>${cap.toFixed(2)}</b>
            </div>
            {usual !== null && likePct !== null && (
              <div>
                <span>Usually costs about</span>
                <b>
                  ${usual.toFixed(2)} · like {likePct}% off
                </b>
              </div>
            )}
            {breakEven !== null && costUsd > 0 && (
              <div>
                <span>Pays for itself after</span>
                <b>
                  {breakEven} extra {breakEven === 1 ? "sale" : "sales"}
                </b>
              </div>
            )}
          </div>

          {editing && (
            <div className="plan-edit">
              <div className="field">
                Match
                <div className="matchlist">
                  {(browse ? list.slice(0, 40) : list.filter((x) => x.slug === slug)).map((x) => (
                    <button key={x.slug} className={x.slug === slug ? "on" : ""} onClick={() => setSlug(x.slug)}>
                      <span>
                        {short(x.teamA)} v {short(x.teamB)}
                        <small>{x.league}</small>
                      </span>
                      <small>sale ends {when(x.kickoff)}</small>
                    </button>
                  ))}
                </div>
                {browse ? (
                  <input className="input" placeholder="Search a team or league" value={query} onChange={(e) => setQuery(e.target.value)} />
                ) : (
                  <button className="link fine" style={{ justifySelf: "start" }} onClick={() => setBrowse(true)}>
                    Choose a different match
                  </button>
                )}
              </div>
              <div className="field">
                Money back if their team wins
                <div className="tiers four" role="radiogroup" aria-label="How much comes back">
                  {SHARES.map((t) => (
                    <button key={t} role="radio" aria-checked={!custom && backPct === t} className={!custom && backPct === t ? "on" : ""} onClick={() => { setCustom(false); setBackPct(t); }}>
                      {t}%<small>{t >= 100 ? "free" : "back"}</small>
                    </button>
                  ))}
                  <button role="radio" aria-checked={custom} className={custom ? "on" : ""} onClick={() => setCustom(true)}>
                    Other<small>you set it</small>
                  </button>
                </div>
                {custom && (
                  <span className="pct-in">
                    <input className="input" type="number" min={10} max={100} step={1} value={backPct} onChange={(e) => setBackPct(Number(e.target.value))} />
                    <i>% back</i>
                  </span>
                )}
              </div>
              <div className="field">
                Offer
                <div className="tiers two" role="radiogroup" aria-label="Who sets the offer">
                  <button role="radio" aria-checked={balance} className={balance ? "on" : ""} onClick={() => setBalance(true)}>
                    My agent balances it<small>keeps your cost even</small>
                  </button>
                  <button role="radio" aria-checked={!balance} className={!balance ? "on" : ""} onClick={() => setBalance(false)}>
                    Fixed<small>same for everyone</small>
                  </button>
                </div>
              </div>
              <div className="field">
                Offer starts
                <div className="tiers four reach-pick" role="radiogroup" aria-label="When the offer switches on">
                  {REACH.map((n) => (
                    <button key={n} role="radio" aria-checked={reach === n} className={reach === n ? "on" : ""} disabled={n > 0 && units > 0 && n > units} onClick={() => setMinBuyers(n)}>
                      {n === 0 ? "Now" : n}
                      <small>{n === 0 ? "first sale" : "buyers"}</small>
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                Referrals <small>a buyer gets their order free once this many friends buy through their link</small>
                <div className="tiers four" role="radiogroup" aria-label="Referrals">
                  {REFS.map((n) => (
                    <button key={n} role="radio" aria-checked={refNeeded === n} className={refNeeded === n ? "on" : ""} disabled={kind === "physical" && n > 0} onClick={() => setRefs(n)}>
                      {n === 0 ? "Off" : n}
                      <small>{n === 0 ? "no referrals" : "friends"}</small>
                    </button>
                  ))}
                </div>
                {kind === "physical" && <small>Not for products you deliver yet: those payments wait for delivery.</small>}
              </div>
              <label className="field">
                What one costs you <small>optional, to see when the drop pays for itself</small>
                <span className="money-in">
                  <i>$</i>
                  <input className="input" type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0" />
                </span>
              </label>
              {!tifoAccount && (
                <div className="grid2">
                  <label className="field">
                    Weekly limit <small>the most your agent&apos;s drops may cost you in a week</small>
                    <span className="money-in">
                      <i>$</i>
                      <input className="input" type="number" min={1} step="1" value={weekly} onChange={(e) => setWeekly(e.target.value)} placeholder={String(weeklyDefault)} />
                    </span>
                  </label>
                  <div className="field">
                    Send my money to
                    <div className="seg">
                      <button className={payoutMode === "this" ? "on" : ""} onClick={() => setPayoutMode("this")}>
                        This Tifo wallet
                      </button>
                      <button className={payoutMode === "other" ? "on" : ""} onClick={() => setPayoutMode("other")}>
                        Another wallet
                      </button>
                    </div>
                    {payoutMode === "other" && <input className="input" value={payoutTo} onChange={(e) => setPayoutTo(e.target.value.trim())} placeholder="0x… an address that accepts USDC on Arc" />}
                  </div>
                </div>
              )}
            </div>
          )}

          {retry && (
            <button className="btn block" onClick={retry}>
              Confirm with {biometric()}
            </button>
          )}
          <div className="plan-actions" hidden={!!retry}>
            <button className="btn" disabled={!!missing || status.kind === "working"} onClick={launch}>
              {missing ?? "Post it"}
            </button>
            {!editing && (
              <button className="btn ghost" onClick={() => setEditing(true)}>
                Change something
              </button>
            )}
            <button className="link fine" onClick={askAgent} disabled={planning}>
              {planning ? "Planning…" : "Plan it again"}
            </button>
          </div>
          {status.text && <p className={`status ${status.kind === "err" ? "err" : ""}`}>{status.text}</p>}
          {!tifoAccount && !editing && <p className="fine">Your agent can run your next drops by itself inside a ${weeklyUsd} weekly limit, and asks you first above it. Change it under Change something.</p>}
        </section>
      )}

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
            if (p.effectiveBps) setBackPct(Math.min(100, Math.max(10, Math.round(p.effectiveBps / 100))));
            if (p.stock) setStock(String(p.stock));
            setPlan((x) => x ?? { slug: p.slug, backPct: Math.round((p.effectiveBps || 5000) / 100), balance: true, minBuyers: 0, reason: "Planned with you in the chat.", byModel: true });
          }}
        />
      </details>
    </div>
  );
}

interface FromPostResult {
  shop: string | null;
  product: string | null;
  priceUsd: number | null;
  priceNote: string | null;
  description: string | null;
  kind: Kind | null;
  stock: number | null;
  image: string | null;
}

/** Optional: start from a post the seller already made. A screenshot, the caption or the post's link. */
function FromPost({ onFill }: { onFill: (x: FromPostResult) => void }) {
  const [open, setOpen] = useState(false);
  const [shot, setShot] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!open)
    return (
      <button className="link fine from-post" onClick={() => setOpen(true)}>
        Have an Instagram post for it? Start from that (optional)
      </button>
    );
  async function read() {
    setBusy(true);
    setMsg(null);
    try {
      const t = text.trim();
      const isLink = /^https?:\/\/\S+$/.test(t);
      const r = await fetch("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: shot || undefined, text: isLink ? undefined : t || undefined, url: isLink ? t : undefined }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      onFill(j as FromPostResult);
      setMsg({ ok: true, text: "Filled in from your post. Check each field before you go on." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="from-post-box">
      <p className="fine">Upload a screenshot of the post, or paste its caption or link. Your agent fills in the product for you.</p>
      <ImageUpload value={shot} onChange={setShot} label="screenshot" />
      <textarea className="input" rows={3} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} placeholder="Paste the caption or the post's link" />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn sm" disabled={busy || (!shot && !text.trim())} onClick={read}>
          {busy ? "Reading…" : "Fill it in"}
        </button>
        <button className="btn sm ghost" onClick={() => setOpen(false)}>
          Skip
        </button>
      </div>
      {msg && <p className={`status ${msg.ok ? "ok" : "err"}`}>{msg.text}</p>}
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
  stock?: number;
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
        {busy && <div className="msg assistant pending">Checking the matches coming up…</div>}
      </div>
      <form onSubmit={send} className="composer">
        <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Message your manager…" disabled={busy} />
        <button className="btn sm" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}
