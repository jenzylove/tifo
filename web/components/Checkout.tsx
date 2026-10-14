"use client";
// The buy box on a drop page: the product at full price, plus a promo that pays back a % if the chosen team wins.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { keccak256, parseSignature, toHex, type Address, type Hex } from "viem";
import { erc20Abi } from "@/lib/abi";
import { setAccount, useAccount } from "@/lib/account";
import { NETWORK, USDC, chain, explorerTx, publicClient } from "@/lib/chain";
import { NeedsTap, biometric, buyWithCircle, circleEnabled, connectCircle, preparePasskey, savedCredential, usdcBalance, walletError } from "@/lib/circleWallet";
import { offerLabel, precheck, stepDown, walletSide } from "@/lib/precheck";
import { lastFew } from "@/lib/offer";
import { slotLabel, slotRef } from "@/lib/booking";
import { connect } from "@/lib/wallet";
import CardTopUp from "./CardTopUp";
import BridgeTopUp from "./BridgeTopUp";
import NairaTopUp from "./NairaTopUp";
import TimePicker from "./TimePicker";
import Purchase, { saveOrder } from "./Purchase";
import { inAppBrowser, openOutside, type InApp } from "@/lib/inapp";

interface Props {
  promo: Address;
  teams: [string, string];
  colors: [string, string];
  rates: [number, number];
  liability: [string, string]; // what each side is already owed if it wins, in USDC units
  cap: string;
  floorBps: number;
  drawBps: number;
  spots?: [number | null, number | null]; // buyers each side still covers at its offer (shown only when nearly gone)
  priceUsd: number;
  product: string;
  shop: string;
  closed: boolean;
  digital: boolean; // the product opens on this page after payment
  contact?: string; // for a physical product: where the buyer sends delivery details
  slots?: { i: number; at: string; taken: boolean }[]; // a bookable service: the times on offer
  reach?: { need: number; have: number } | null; // the offer switches on once `need` different people bought
  moving?: boolean; // the agent moves the offers as fans pick sides
}

type Status = { kind: "idle" } | { kind: "working"; text: string } | { kind: "done"; hash: Hex; secret: Hex; side: 0 | 1; qty: number } | { kind: "error"; text: string };

const money = (n: number) => `$${n.toFixed(2)}`;

/** The order reference on chain is the hash of a secret kept in this browser. Showing the secret later proves the order. */
function newOrder(): { secret: Hex; orderRef: Hex } {
  const secret = toHex(crypto.getRandomValues(new Uint8Array(32)));
  return { secret, orderRef: keccak256(secret) };
}

export default function Checkout({ promo, teams, colors, rates: listed, liability, cap, floorBps, drawBps, spots, priceUsd, product, shop, closed, digital, contact, slots, reach, moving }: Props) {
  const router = useRouter();
  // The agent moved the offer between page load and payment: show the new one and let the buyer decide again.
  const fail = (e: unknown) => {
    const m = (e as Error)?.message ?? String(e);
    if (/OfferGone/i.test(m)) router.refresh();
    setStatus({ kind: "error", text: friendly(m) });
  };
  const acct = useAccount();
  const [side, setSide] = useState<0 | 1 | null>(null);
  // Opened from another buyer's challenge link: which side they backed, and (if the link says) their wallet.
  const [rival, setRival] = useState<{ side: 0 | 1; from: string | null } | null>(null);
  const [shared, setShared] = useState(false);
  const [qty, setQty] = useState(1);
  const [slot, setSlot] = useState<number | null>(null); // the time picked, for a bookable service
  const booking = !!slots?.length;
  const [balance, setBalance] = useState<bigint | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [hasSaved, setHasSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [locked, setLocked] = useState<0 | 1 | null>(null); // the offer this wallet already took
  const [bio, setBio] = useState("Face ID or fingerprint");
  const [cardOn, setCardOn] = useState(false); // card payments are set up on this deployment
  const [card, setCard] = useState(false);
  const [bridge, setBridge] = useState(false);
  const [nairaOn, setNairaOn] = useState(false); // paying in naira (through Bachs) is set up on this deployment
  const [naira, setNaira] = useState(false);
  const [nairaPrice, setNairaPrice] = useState(""); // the naira for what is left to pay, charges included
  const [usdcOpen, setUsdcOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [inApp, setInApp] = useState<InApp>(null); // opened inside Telegram, Instagram, Facebook...: passkeys do not work there
  const [linkCopied, setLinkCopied] = useState(false);
  useEffect(() => setInApp(inAppBrowser()), []); // the pay sheet: wallet, ways to add money, other wallets
  const [tap, setTap] = useState<null | { go: () => Promise<Hex>; secret: Hex }>(null);

  useEffect(() => {
    fetch("/api/onramp/sessions").then((r) => r.json()).then((j) => setCardOn(!!j.enabled)).catch(() => {});
    fetch("/api/naira/start").then((r) => r.json()).then((j) => setNairaOn(!!j.enabled)).catch(() => {});
    setHasSaved(!!savedCredential());
    setBio(biometric());
    if (circleEnabled() && !closed) preparePasskey().catch(() => {});
  }, [closed]);
  useEffect(() => {
    // A challenge link carries ?vs=<the side the sender backed>. Start this buyer on the other side.
    const q = new URLSearchParams(location.search);
    const vs = q.get("vs");
    if (vs !== "0" && vs !== "1") return;
    const from = q.get("from");
    const theirs = Number(vs) as 0 | 1;
    setRival({ side: theirs, from: from && /^0x[0-9a-fA-F]{40}$/.test(from) ? from : null });
    setSide((s) => s ?? ((1 - theirs) as 0 | 1));
  }, []);
  useEffect(() => {
    // Back from the Bachs page (it adds ?checkout_id= to the address): ask once whether the naira payment landed, then tidy the address.
    const id = new URLSearchParams(location.search).get("checkout_id");
    if (!id || !/^chk_[A-Za-z0-9]+$/.test(id)) return;
    fetch("/api/naira/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ checkoutId: id }) }).catch(() => {});
    const url = new URL(location.href);
    url.searchParams.delete("checkout_id");
    history.replaceState(history.state, "", url);
  }, []);
  useEffect(() => {
    if (!acct) return;
    walletSide(promo, acct.address)
      .then((s) => {
        setLocked(s);
        if (s !== null) setSide(s);
      })
      .catch(() => {});
  }, [acct, promo, status.kind]);
  useEffect(() => {
    if (!acct) return;
    let live = true;
    const poll = () => usdcBalance(acct.address).then((b) => live && setBalance(b)).catch(() => {});
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [acct]);

  const total = priceUsd * qty;
  const amount = BigInt(Math.round(total * 1e6));
  const shortfall = Math.max(total - Number(balance ?? 0n) / 1e6, 1);
  useEffect(() => {
    if (!sheet || !nairaOn || !acct) return;
    let live = true;
    fetch(`/api/naira/start?usd=${Math.ceil(Math.round(shortfall * 1e6) / 1e4) / 100}`)
      .then((r) => r.json())
      .then((j) => live && setNairaPrice(j.ngn ? `₦${Number(j.ngn).toLocaleString("en-US")}` : ""))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sheet, nairaOn, acct, shortfall]);
  // What this order would get right now, after spots already taken. The contract makes the same step down.
  const rates = [0, 1].map((s) => stepDown(amount, listed[s], BigInt(liability[s]), BigInt(cap), floorBps)) as [number, number];
  const back = (s: 0 | 1) => (total * rates[s]) / 10_000;
  const enough = balance !== null && balance >= amount;
  const busy = status.kind === "working";

  async function wallet(mode: "register" | "login") {
    setStatus({ kind: "working", text: mode === "register" ? "Creating your wallet…" : "Signing in…" });
    try {
      setAccount(await connectCircle(mode));
      setStatus({ kind: "idle" });
    } catch (e) {
      setStatus({ kind: "error", text: walletError(e) });
    }
  }

  /** A bookable service pays against the slot's own reference, so the contract refuses a second booking of it. */
  function order(): { secret: Hex; orderRef: Hex } {
    const o = newOrder();
    return booking && slot !== null ? { secret: o.secret, orderRef: slotRef(promo, slot) } : o;
  }

  async function pay() {
    if (!acct || side === null) return;
    if (booking && slot === null) return setStatus({ kind: "error", text: "Pick a time first." });
    try {
      setStatus({ kind: "working", text: "Checking the promo…" });
      const pre = await precheck(promo, acct.address, side, amount, teams);
      if ("error" in pre) return setStatus({ kind: "error", text: pre.error });
      if (pre.rateBps < rates[side]) {
        router.refresh();
        return setStatus({ kind: "error", text: `The ${teams[side]} offer just moved to ${pre.rateBps >= 10_000 ? "free" : pre.rateBps > 0 ? `${pre.rateBps / 100}% back` : "no money back"} as other fans bought. Check it and pay again.` });
      }
      setStatus({ kind: "working", text: `Confirm with ${bio}…` });
      const { secret, orderRef } = order();
      try {
        done(await buyWithCircle(acct, promo, side, amount, orderRef, rates[side]), secret);
      } catch (e) {
        if (!(e instanceof NeedsTap)) throw e;
        setTap({ go: e.go, secret });
        return setStatus({ kind: "idle" });
      }
    } catch (e) {
      fail(e);
    }
  }

  function done(hash: Hex, secret: Hex) {
    setTap(null);
    saveOrder(promo, { hash, secret });
    setStatus({ kind: "done", hash, secret, side: side!, qty });
    // If this buyer came from a rival's challenge link, the agent notes the pair on chain after checking both orders.
    const pair = rival?.from && acct && side !== rival.side ? { buyer: acct.address, from: rival.from } : {};
    fetch("/api/after-sale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ promo, ...pair }) }).catch(() => {});
  }

  async function confirmTap() {
    if (!tap) return;
    try {
      setStatus({ kind: "working", text: `Confirm with ${bio}…` });
      done(await tap.go(), tap.secret);
    } catch (e) {
      setTap(null);
      fail(e);
    }
  }

  async function payOtherWallet() {
    if (side === null) return;
    if (booking && slot === null) return setStatus({ kind: "error", text: "Pick a time first." });
    try {
      setStatus({ kind: "working", text: "Connecting wallet…" });
      const { address, client } = await connect();
      const bal = (await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] })) as bigint;
      if (bal < amount) throw new Error(`This wallet has ${money(Number(bal) / 1e6)} USDC on Arc. You need ${money(total)}.`);
      const pre = await precheck(promo, address, side, amount, teams);
      if ("error" in pre) throw new Error(pre.error);
      if (pre.rateBps < rates[side]) throw new Error(GONE);
      const nonce = (await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "nonces", args: [address] })) as bigint;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
      setStatus({ kind: "working", text: "Sign to pay. No gas needed." });
      const sig = await client.signTypedData({
        account: address,
        domain: { name: "USDC", version: "2", chainId: chain.id, verifyingContract: USDC },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: { owner: address, spender: promo, value: amount, nonce, deadline },
      });
      const { r, s, v, yParity } = parseSignature(sig);
      setStatus({ kind: "working", text: "Paying on Arc…" });
      const { secret, orderRef } = order();
      const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          promo,
          buyer: address,
          side,
          amount: amount.toString(),
          orderRef,
          minRateBps: rates[side],
          deadline: deadline.toString(),
          v: Number(v ?? BigInt(27 + (yParity ?? 0))),
          r,
          s,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Payment failed");
      saveOrder(promo, { hash: j.hash, secret });
      setStatus({ kind: "done", hash: j.hash, secret, side, qty });
    } catch (e) {
      fail(e);
    }
  }

  if (status.kind === "done") {
    const t = teams[status.side];
    const when = booking && slot !== null ? slotLabel(slots!.find((x) => x.i === slot)!.at) : null;
    const msg = when
      ? `Hi ${shop}, I booked ${product} for ${when} on Tifo. Receipt: ${explorerTx(status.hash)}`
      : `Hi ${shop}, I just bought ${status.qty} × ${product} on Tifo. Receipt: ${explorerTx(status.hash)}`;
    const wa = contact ? (/^https?:/.test(contact) ? contact : `https://wa.me/${contact.replace(/[^\d]/g, "")}?text=${encodeURIComponent(msg)}`) : null;
    // The challenge: send the same drop to a fan of the other team, opened on their side.
    const other = (1 - status.side) as 0 | 1;
    const challengeUrl = `${location.origin}/p/${promo}?vs=${status.side}${acct ? `&from=${acct.address}` : ""}`;
    const challengeText = `I backed ${t} on ${product} from ${shop}. Your turn: ${offerLabel(rates[other], teams[other])}.`;
    const challenge = async () => {
      try {
        if (navigator.share) await navigator.share({ text: challengeText, url: challengeUrl });
        else await navigator.clipboard.writeText(`${challengeText} ${challengeUrl}`);
        setShared(true);
      } catch {
        // the share sheet was closed: nothing to do
      }
    };
    return (
      <div className="done">
        <b>{when ? `Booked for ${when}.` : "Order paid."}</b>
        <p className="fine">
          {back(status.side) > 0
            ? `Your promo is locked: if ${t} win, ${money(back(status.side))} comes back to this wallet after full time.`
            : "Your order is in."}
        </p>
        {digital && <Purchase promo={promo} product={product} order={{ hash: status.hash, secret: status.secret }} />}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {wa && (
            <a className="btn sm" href={wa} target="_blank" rel="noreferrer">
              {when ? `Message ${shop} on WhatsApp` : `Send delivery details to ${shop}`}
            </a>
          )}
          <a className="btn sm ghost" href={explorerTx(status.hash)} target="_blank" rel="noreferrer">
            Receipt
          </a>
        </div>
        {!closed && (
          <div className="challenge">
            <b>Know a {teams[other]} fan?</b>
            <p className="fine">
              Send them this drop, already set to {teams[other]}. The one whose team wins gets money back.
              {reach && reach.have < reach.need ? ` The offer switches on once ${reach.need} people buy, so every share counts.` : ""}
            </p>
            <button className="btn sm ac" onClick={challenge}>
              {shared ? "Sent. Challenge another" : `Challenge a ${teams[other]} fan`}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="buybox">
      <div className="promo">
        {rival && !closed && (
          <p className="rival-note">
            A <b>{teams[rival.side]}</b> fan sent you this. Take <b>{teams[1 - rival.side]}</b>.
          </p>
        )}
        <h4>Pick your side</h4>
        {reach && reach.have < reach.need && (
          <div className="reach">
            <div className="reach-bar" aria-hidden>
              <i style={{ width: `${Math.max(6, Math.min(100, (reach.have / reach.need) * 100))}%` }} />
            </div>
            <p className="fine">
              <b>
                {reach.need - reach.have} more {reach.need - reach.have === 1 ? "buyer switches" : "buyers switch"} the offer on.
              </b>{" "}
              {reach.have} of {reach.need} so far. If fewer buy before kickoff, everyone keeps what they bought at full price.
            </p>
          </div>
        )}
        {reach && reach.have >= reach.need && <p className="fine reach-on">Offer on: {reach.have} people bought.</p>}
        <div className="offers-list">
          {[0, 1].map((i) => {
            const s = i as 0 | 1;
            const off = locked !== null && locked !== s;
            return (
              <button key={s} className={`offer ${side === s ? "on" : ""}`} style={{ ["--c" as string]: colors[s] }} onClick={() => setSide(s)} disabled={closed || off}>
                <span className="radio" aria-hidden />
                <span className="txt">
                  <b>{offerLabel(rates[s], teams[s])}</b>
                  {lastFew(spots?.[s] ?? null) && <small>{lastFew(spots?.[s] ?? null)}</small>}
                </span>
                <span className="amt">{rates[s] > 0 ? money(back(s)) : ""}</span>
              </button>
            );
          })}
        </div>
        <p className="fine">
          {locked !== null
            ? `This wallet already took the ${teams[locked]} offer, so more orders ride on ${teams[locked]} too.`
            : moving
              ? "Pick the team you think will win. Offers move as fans pick sides; yours is locked when you pay."
              : "Pick the team you think will win. You keep what you bought either way."}
        </p>
      </div>

      {booking && (
        <div className="promo">
          <h4>Pick a time</h4>
          <TimePicker slots={slots!} value={slot} onChange={setSlot} disabled={closed} />
        </div>
      )}

      <div className="totals" hidden={booking}>
        <div className="qty" aria-label="Quantity">
          <button onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="One less">−</button>
          <span>{qty}</span>
          <button onClick={() => setQty((q) => Math.min(20, q + 1))} aria-label="One more">+</button>
        </div>
        <div className="sum">
          Total <b>{money(total)}</b>
        </div>
      </div>

      {closed ? (
        <button className="btn block" disabled>
          Promo closed at kickoff
        </button>
      ) : (
        <button
          className="btn block"
          disabled={side === null || busy || (booking && slot === null)}
          onClick={() => (circleEnabled() && acct && enough && !tap ? pay() : setSheet(true))}
        >
          {side === null ? "Pick a side to continue" : booking && slot === null ? "Pick a time to continue" : acct && enough ? `Pay ${money(total)} with ${bio}` : `Pay ${money(total)}`}
        </button>
      )}
      {acct && !sheet && balance !== null && (
        <p className="fine" style={{ textAlign: "center" }}>
          Your Tifo wallet has {money(Number(balance) / 1e6)}
        </p>
      )}
      {sheet && side !== null && typeof document !== "undefined" &&
        createPortal(
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Pay">
            <div className="sheet-card pay-sheet">
              <header>
                <b>
                  Pay {money(total)} <small className="fine">· {offerLabel(rates[side], teams[side])}</small>
                </b>
                <button className="link" onClick={() => setSheet(false)}>
                  Close
                </button>
              </header>

              {!circleEnabled() ? null : inApp && !acct ? (
                <section className="inapp">
                  <h5>Open this page in {inApp.ios ? "Safari" : "Chrome"} to pay</h5>
                  <p className="fine">
                    You opened the link inside {inApp.name}. Phones do not allow {bio} in {inApp.name}&apos;s built-in browser, so the wallet cannot be made here.
                    It takes one tap to continue in {inApp.ios ? "Safari" : "Chrome"}.
                  </p>
                  <a className="btn block" href={openOutside()}>
                    Open in {inApp.ios ? "Safari" : "Chrome"}
                  </a>
                  <button
                    className="link fine"
                    onClick={() => {
                      navigator.clipboard?.writeText(location.href);
                      setLinkCopied(true);
                    }}
                  >
                    {linkCopied ? `Link copied. Paste it in ${inApp.ios ? "Safari" : "Chrome"}` : "Didn't open? Copy the link instead"}
                  </button>
                  <p className="fine">
                    Or tap the <b>⋯</b> menu in {inApp.name} and choose &quot;Open in {inApp.ios ? "Safari" : "browser"}&quot;.
                  </p>
                </section>
              ) : !acct ? (
                <section>
                  <h5>Your Tifo wallet</h5>
                  <p className="fine">Made in seconds with {bio}. No seed phrase, no gas. Any money back lands here.</p>
                  <button className="btn block" disabled={busy} onClick={() => wallet(hasSaved ? "login" : "register")}>
                    {hasSaved ? `Sign in with ${bio}` : `Create a wallet with ${bio}`}
                  </button>
                  <button className="link fine" onClick={() => wallet(hasSaved ? "register" : "login")}>
                    {hasSaved ? "Create a new wallet instead" : "I already have one"}
                  </button>
                </section>
              ) : enough || tap ? (
                <section>
                  <h5>Ready to pay</h5>
                  <p className="fine">From your Tifo wallet, which has {money(Number(balance ?? 0n) / 1e6)}.</p>
                  <button className="btn block" disabled={busy} onClick={tap ? confirmTap : pay}>
                    Confirm {money(total)} with {bio}
                  </button>
                </section>
              ) : (
                <section>
                  <h5>How do you want to pay?</h5>
                  {balance !== null && balance > 0n && (
                    <p className="fine">Your Tifo wallet already has {money(Number(balance) / 1e6)} towards this, so you only pay the rest.</p>
                  )}
                  <div className="pay-ways">
                    {nairaOn && (
                      <button onClick={() => setNaira(true)}>
                        <b>{nairaPrice ? `Pay ${nairaPrice}` : "Pay in naira"}</b>
                        <span>Bank transfer or card in naira</span>
                      </button>
                    )}
                    {cardOn && (
                      <button onClick={() => setCard(true)}>
                        <b>Pay by card</b>
                        <span>In your own currency, through Circle</span>
                      </button>
                    )}
                    <button className={usdcOpen ? "on" : ""} aria-expanded={usdcOpen} onClick={() => setUsdcOpen((o) => !o)}>
                      <b>Pay with USDC</b>
                      <span>From another chain, an exchange, or MetaMask</span>
                    </button>
                    {usdcOpen && (
                      <div className="pay-sub">
                        <button onClick={() => setBridge(true)}>
                          <b>From another chain</b>
                          <span>Base, Ethereum, Arbitrum, Optimism or Polygon</span>
                        </button>
                        <button
                          onClick={() => {
                            navigator.clipboard?.writeText(acct.address);
                            setCopied(true);
                          }}
                        >
                          <b>{copied ? "Address copied" : "From an exchange"}</b>
                          <span>{copied ? "Withdraw USDC to it and pick the Arc network" : "Copy your address, withdraw USDC on Arc"}</span>
                        </button>
                        <button disabled={busy} onClick={payOtherWallet}>
                          <b>MetaMask or Rabby</b>
                          <span>Pay with USDC you already hold on Arc</span>
                        </button>
                        {NETWORK === "testnet" && (
                          <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                            <b>Free test USDC</b>
                            <span>faucet.circle.com, pick Arc Testnet</span>
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                  <button className="link fine switch" disabled={busy} onClick={() => wallet("login")}>
                    Money in another Tifo wallet? Switch
                  </button>
                </section>
              )}

              {status.kind === "working" && <p className="status">{status.text}</p>}
              {status.kind === "error" && <p className="status err">{status.text}</p>}
            </div>
          </div>,
          document.body,
        )}
      {bridge && acct && <BridgeTopUp recipient={acct.address} neededUsd={Math.max(total - Number(balance ?? 0n) / 1e6, 1)} onClose={() => setBridge(false)} />}
      {naira && acct && <NairaTopUp address={acct.address} promo={promo} amountUsd={Math.max(total - Number(balance ?? 0n) / 1e6, 1)} onClose={() => setNaira(false)} />}
      {card && acct && <CardTopUp address={acct.address} amountUsd={Math.max(total - Number(balance ?? 0n) / 1e6, 1)} onClose={() => setCard(false)} />}
      {status.kind === "working" && <p className="status">{status.text}</p>}
      {status.kind === "error" && <p className="status err">{status.text}</p>}
    </div>
  );
}

const GONE = "That offer just moved as other fans bought. Check the new offer and pay again.";

function friendly(msg: string) {
  if (/OfferGone/i.test(msg)) return GONE;
  if (/DuplicateOrder/i.test(msg)) return "This order already went through, or that time was just booked by someone else. You were not charged twice. Refresh to see the free times.";
  if (/OverCap/i.test(msg)) return "The shop's budget for this offer is used up at this size. Try fewer items or the other offer.";
  if (/OneSidePerWallet/i.test(msg)) return "This wallet already took the other offer in this promo.";
  if (/Closed/i.test(msg)) return "This promo closed at kickoff.";
  if (/reverted/i.test(msg)) return "The payment didn't go through and nothing was charged. Refresh the page and try again.";
  return walletError(new Error(msg));
}
