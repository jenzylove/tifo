"use client";
// The buy box on a drop page: pick a team, pick a quantity, pay with a Circle passkey wallet.
import { useEffect, useState } from "react";
import { keccak256, parseSignature, toBytes, type Address } from "viem";
import { erc20Abi } from "@/lib/abi";
import { setAccount, useAccount } from "@/lib/account";
import { NETWORK, USDC, chain, explorerTx, publicClient } from "@/lib/chain";
import { buyWithCircle, circleEnabled, connectCircle, savedCredential, usdcBalance } from "@/lib/circleWallet";
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

  useEffect(() => setHasSaved(!!savedCredential()), []);
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
      setStatus({ kind: "error", text: friendly((e as Error).message) });
    }
  }

  async function pay() {
    if (!acct || side === null) return;
    try {
      setStatus({ kind: "working", text: "Confirm with your fingerprint or Face ID…" });
      const hash = await buyWithCircle(acct, promo, side, amount);
      setStatus({ kind: "done", hash, side, qty });
      fetch("/api/after-sale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ promo }) }).catch(() => {});
    } catch (e) {
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
    const msg = `Hi ${shop}, I just bought ${status.qty} × ${product} on Tifo (backing ${t}). Receipt: ${explorerTx(status.hash)}`;
    const wa = whatsapp ? (/^https?:/.test(whatsapp) ? whatsapp : `https://wa.me/${whatsapp.replace(/[^\d]/g, "")}?text=${encodeURIComponent(msg)}`) : null;
    return (
      <div className="done">
        <b>Order paid. You&apos;re in the {t} stand.</b>
        <p className="fine">
          If {t} win, {money(back(status.side))} comes back to this wallet after full time. Your % is locked.
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
      <div>
        <h4>Pick your team</h4>
        <div className="sides" style={{ marginTop: 8 }}>
          {[0, 1].map((i) => {
            const s = i as 0 | 1;
            return (
              <button key={s} className={`side ${side === s ? "on" : ""}`} style={{ ["--c" as string]: colors[s] }} onClick={() => setSide(s)} disabled={closed}>
                <span className="t">{teams[s]}</span>
                <span className="pct">{rates[s] / 100}%</span>
                <span className="back">back if they win · {money(back(s))}</span>
              </button>
            );
          })}
        </div>
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
          Orders closed at kickoff
        </button>
      ) : !circleEnabled() ? (
        <button className="btn block" disabled={side === null || busy} onClick={payOtherWallet}>
          {side === null ? "Pick a team to continue" : `Pay ${money(total)}`}
        </button>
      ) : !acct ? (
        <div style={{ display: "grid", gap: 8 }}>
          <button className="btn block" disabled={busy} onClick={() => wallet(hasSaved ? "login" : "register")}>
            {hasSaved ? "Sign in with fingerprint to pay" : "Create a wallet with your fingerprint"}
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
          <button className="btn block" disabled={side === null || !enough || busy} onClick={pay}>
            {side === null ? "Pick a team to continue" : `Pay ${money(total)} as a ${teams[side]} fan`}
          </button>
        </div>
      )}
      {circleEnabled() && !closed && (
        <button className="link" style={{ justifySelf: "center" }} onClick={payOtherWallet} disabled={busy || side === null}>
          or pay with MetaMask / Rabby
        </button>
      )}
      {status.kind === "working" && <p className="status">{status.text}</p>}
      {status.kind === "error" && <p className="status err">{status.text}</p>}

      <div className="assure">
        <div>You pay {shop}&apos;s normal price and keep the product whatever the score.</div>
        <div>A draw pays no rebate. The rebate goes to the wallet you paid from.</div>
      </div>
    </div>
  );
}

function friendly(msg: string) {
  if (/OverCap/i.test(msg)) return "This team's side is full at the current offer. Try the other side, or fewer items.";
  if (/OneSidePerWallet/i.test(msg)) return "This wallet already backed the other team in this drop.";
  if (/Closed/i.test(msg)) return "This drop closed at kickoff.";
  if (/NotAllowed|abort|cancel/i.test(msg)) return "Cancelled.";
  return msg.split("\n")[0];
}
