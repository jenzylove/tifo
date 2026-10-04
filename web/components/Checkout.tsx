"use client";
// The buy box on a drop page: the product at full price, plus a promo that pays back a % if the chosen team wins.
import { useEffect, useState } from "react";
import { keccak256, parseSignature, toBytes, type Address } from "viem";
import { erc20Abi } from "@/lib/abi";
import { setAccount, useAccount } from "@/lib/account";
import { NETWORK, USDC, chain, explorerTx, publicClient } from "@/lib/chain";
import { NeedsTap, biometric, buyWithCircle, circleEnabled, connectCircle, preparePasskey, savedCredential, usdcBalance, walletError } from "@/lib/circleWallet";
import { precheck, walletSide } from "@/lib/precheck";
import { connect } from "@/lib/wallet";

interface Props {
  promo: Address;
  teams: [string, string];
  colors: [string, string];
  rates: [number, number];
  priceUsd: number;
  product: string;
  shop: string;
  closed: boolean;
  whatsapp?: string; // shop's WhatsApp, for sending the order details
}

type Status = { kind: "idle" } | { kind: "working"; text: string } | { kind: "done"; hash: string; side: 0 | 1; qty: number } | { kind: "error"; text: string };

const money = (n: number) => `$${n.toFixed(2)}`;

export default function Checkout({ promo, teams, colors, rates, priceUsd, product, shop, closed, whatsapp }: Props) {
  const acct = useAccount();
  const [side, setSide] = useState<0 | 1 | null>(null);
  const [qty, setQty] = useState(1);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [hasSaved, setHasSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [locked, setLocked] = useState<0 | 1 | null>(null); // the offer this wallet already took
  const [bio, setBio] = useState("Face ID or fingerprint");
  const [tap, setTap] = useState<null | (() => Promise<`0x${string}`>)>(null);

  useEffect(() => {
    setHasSaved(!!savedCredential());
    setBio(biometric());
    if (circleEnabled() && !closed) preparePasskey().catch(() => {});
  }, [closed]);
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

  async function pay() {
    if (!acct || side === null) return;
    try {
      setStatus({ kind: "working", text: "Checking the promo…" });
      const why = await precheck(promo, acct.address, side, amount, teams);
      if (why) return setStatus({ kind: "error", text: why });
      setStatus({ kind: "working", text: `Confirm with ${bio}…` });
      done(await buyWithCircle(acct, promo, side, amount));
    } catch (e) {
      if (e instanceof NeedsTap) {
        setTap(() => e.go);
        return setStatus({ kind: "idle" });
      }
      setStatus({ kind: "error", text: friendly((e as Error).message) });
    }
  }

  function done(hash: `0x${string}`) {
    setTap(null);
    setStatus({ kind: "done", hash, side: side!, qty });
    fetch("/api/after-sale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ promo }) }).catch(() => {});
  }

  async function confirmTap() {
    if (!tap) return;
    try {
      setStatus({ kind: "working", text: `Confirm with ${bio}…` });
      done(await tap());
    } catch (e) {
      setTap(null);
      setStatus({ kind: "error", text: friendly((e as Error).message) });
    }
  }

  async function payOtherWallet() {
    if (side === null) return;
    try {
      setStatus({ kind: "working", text: "Connecting wallet…" });
      const { address, client } = await connect();
      const bal = (await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] })) as bigint;
      if (bal < amount) throw new Error(`This wallet has ${money(Number(bal) / 1e6)} USDC on Arc. You need ${money(total)}.`);
      const why = await precheck(promo, address, side, amount, teams);
      if (why) throw new Error(why);
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
      const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          promo,
          buyer: address,
          side,
          amount: amount.toString(),
          orderRef: keccak256(toBytes(`${promo}:${address}:${Date.now()}`)),
          deadline: deadline.toString(),
          v: Number(v ?? BigInt(27 + (yParity ?? 0))),
          r,
          s,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Payment failed");
      setStatus({ kind: "done", hash: j.hash, side, qty });
    } catch (e) {
      setStatus({ kind: "error", text: friendly((e as Error).message) });
    }
  }

  if (status.kind === "done") {
    const t = teams[status.side];
    const msg = `Hi ${shop}, I just bought ${status.qty} × ${product} on Tifo. Receipt: ${explorerTx(status.hash)}`;
    const wa = whatsapp ? (/^https?:/.test(whatsapp) ? whatsapp : `https://wa.me/${whatsapp.replace(/[^\d]/g, "")}?text=${encodeURIComponent(msg)}`) : null;
    return (
      <div className="done">
        <b>Order paid.</b>
        <p className="fine">
          Your promo is locked: if {t} win, {money(back(status.side))} comes back to this wallet after full time.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {wa && (
            <a className="btn sm" href={wa} target="_blank" rel="noreferrer">
              Send delivery details to {shop}
            </a>
          )}
          <a className="btn sm ghost" href={explorerTx(status.hash)} target="_blank" rel="noreferrer">
            Receipt
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="buybox">
      <div className="promo">
        <h4>Matchday promo</h4>
        <div className="offers-list">
          {[0, 1].map((i) => {
            const s = i as 0 | 1;
            const off = locked !== null && locked !== s;
            return (
              <button key={s} className={`offer ${side === s ? "on" : ""}`} style={{ ["--c" as string]: colors[s] }} onClick={() => setSide(s)} disabled={closed || off}>
                <span className="radio" aria-hidden />
                <span className="txt">
                  Get <b>{rates[s] / 100}% back</b> if {teams[s]} win
                </span>
                <span className="amt">{money(back(s))}</span>
              </button>
            );
          })}
        </div>
        <p className="fine">
          {locked !== null
            ? `This wallet already took the ${teams[locked]} offer, so more orders ride on ${teams[locked]} too.`
            : "Choose the result your discount rides on. A draw pays no rebate, and you keep the product either way."}
        </p>
      </div>

      <div className="totals">
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
      ) : !circleEnabled() ? (
        <button className="btn block" disabled={side === null || busy} onClick={payOtherWallet}>
          {side === null ? "Choose a promo to continue" : `Buy for ${money(total)}`}
        </button>
      ) : !acct ? (
        <div style={{ display: "grid", gap: 8 }}>
          <button className="btn block" disabled={busy} onClick={() => wallet(hasSaved ? "login" : "register")}>
            {hasSaved ? `Sign in with ${bio} to buy` : `Create a wallet with ${bio}`}
          </button>
          <p className="fine" style={{ textAlign: "center" }}>
            {hasSaved ? (
              <button className="link" onClick={() => wallet("register")}>Create a new wallet instead</button>
            ) : (
              <>
                A Circle wallet in seconds. No seed phrase, no gas.{" "}
                <button className="link" onClick={() => wallet("login")}>I already have one</button>
              </>
            )}
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          <div className="walletline">
            Paying from <code>{acct.address.slice(0, 6)}…{acct.address.slice(-4)}</code>
            <span>
              Balance <b style={{ color: "var(--ink)" }}>{balance === null ? "…" : money(Number(balance) / 1e6)}</b>
            </span>
          </div>
          {balance !== null && !enough && (
            <div className="fundbox">
              <span>
                Add {money(total - Number(balance) / 1e6)} or more in USDC on the <b>Arc</b> network to this wallet. You can withdraw from most big exchanges and
                choose Arc.
                {NETWORK === "testnet" && (
                  <>
                    {" "}
                    On testnet, get free USDC at{" "}
                    <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                      faucet.circle.com
                    </a>{" "}
                    (pick Arc Testnet).
                  </>
                )}
              </span>
              <button
                className="btn sm ghost"
                style={{ justifySelf: "start" }}
                onClick={() => {
                  navigator.clipboard?.writeText(acct.address);
                  setCopied(true);
                }}
              >
                {copied ? "Address copied" : "Copy my wallet address"}
              </button>
            </div>
          )}
          {tap ? (
            <button className="btn block" disabled={busy} onClick={confirmTap}>
              Confirm {money(total)} with {bio}
            </button>
          ) : (
            <button className="btn block" disabled={side === null || !enough || busy} onClick={pay}>
              {side === null ? "Choose a promo to continue" : `Buy for ${money(total)}`}
            </button>
          )}
        </div>
      )}
      {circleEnabled() && !closed && (
        <button className="link" style={{ justifySelf: "center" }} onClick={payOtherWallet} disabled={busy || side === null}>
          or pay with MetaMask / Rabby
        </button>
      )}
      {status.kind === "working" && <p className="status">{status.text}</p>}
      {status.kind === "error" && <p className="status err">{status.text}</p>}
    </div>
  );
}

function friendly(msg: string) {
  if (/OverCap/i.test(msg)) return "The shop's budget for this offer is used up at this size. Try fewer items or the other offer.";
  if (/OneSidePerWallet/i.test(msg)) return "This wallet already took the other offer in this promo.";
  if (/Closed/i.test(msg)) return "This promo closed at kickoff.";
  if (/reverted/i.test(msg)) return "The payment didn't go through and nothing was charged. Refresh the page and try again.";
  return walletError(new Error(msg));
}
