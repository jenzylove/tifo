"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { keccak256, parseSignature, toBytes, type Address } from "viem";
import type { SmartAccount } from "viem/account-abstraction";
import { erc20Abi } from "@/lib/abi";
import { NETWORK, USDC, chain, explorerTx, publicClient } from "@/lib/chain";
import { buyWithCircle, circleEnabled, connectCircle, restoreCircle, savedCredential, usdcBalance } from "@/lib/circleWallet";
import { connect } from "@/lib/wallet";

// One Circle wallet shared by both sides of the page.
let account: SmartAccount | null = null;
const listeners = new Set<() => void>();
const setAccount = (a: SmartAccount | null) => {
  account = a;
  listeners.forEach((l) => l());
};
const useAccount = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => account,
    () => null,
  );

/** Wallet bar shown once at the top of a promo page. */
export function WalletBar({ priceUsd }: { priceUsd: number }) {
  const acct = useAccount();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);

  useEffect(() => {
    setHasSaved(!!savedCredential());
    if (!account && savedCredential()) restoreCircle().then((a) => a && setAccount(a)).catch(() => {});
  }, []);

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

  if (!circleEnabled()) return null;

  async function go(mode: "register" | "login") {
    setErr("");
    setBusy(mode === "register" ? "Creating your wallet…" : "Signing in…");
    try {
      setAccount(await connectCircle(mode));
    } catch (e) {
      setErr((e as Error).message.split("\n")[0]);
    } finally {
      setBusy("");
    }
  }

  if (!acct)
    return (
      <div className="walletbar">
        <div>
          <b>Pay with Face ID or fingerprint.</b> A Circle wallet is created on this device in seconds. No seed phrase, no gas.
        </div>
        <div className="row">
          <button className="pay" disabled={!!busy} onClick={() => go("register")}>
            Create my wallet
          </button>
          {hasSaved ? (
            <button className="ghost" disabled={!!busy} onClick={() => go("login")}>
              I have one
            </button>
          ) : null}
        </div>
        {busy && <p className="status">{busy}</p>}
        {err && <p className="status err">{err}</p>}
      </div>
    );

  const short = `${acct.address.slice(0, 6)}…${acct.address.slice(-4)}`;
  const enough = balance !== null && balance >= BigInt(Math.round(priceUsd * 1e6));
  return (
    <div className="walletbar">
      <div>
        Your Circle wallet <code>{short}</code> · <b>{balance === null ? "…" : `$${(Number(balance) / 1e6).toFixed(2)}`}</b> USDC on Arc
      </div>
      {!enough && (
        <div className="fund">
          <p>
            Add USDC to this address on the <b>Arc</b> network (withdraw from Binance, Bybit, OKX, Coinbase or Kraken and pick Arc).
            {NETWORK === "testnet" && (
              <>
                {" "}
                Testnet: get free USDC at <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">faucet.circle.com</a> (choose Arc Testnet).
              </>
            )}
          </p>
          <button
            className="ghost"
            onClick={() => {
              navigator.clipboard?.writeText(acct.address);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy my address"}
          </button>
        </div>
      )}
    </div>
  );
}

interface Props {
  promo: Address;
  side: 0 | 1;
  team: string;
  rateBps: number;
  priceUsd: number;
  product: string;
  closed: boolean;
}

type Status = { kind: "idle" } | { kind: "working"; text: string } | { kind: "done"; hash: string } | { kind: "error"; text: string };

export default function Checkout({ promo, side, team, rateBps, priceUsd, product, closed }: Props) {
  const acct = useAccount();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const back = ((priceUsd * rateBps) / 10_000).toFixed(2);
  const amount = BigInt(Math.round(priceUsd * 1e6));

  async function payCircle() {
    if (!acct) return;
    try {
      setStatus({ kind: "working", text: "Confirm with Face ID…" });
      const hash = await buyWithCircle(acct, promo, side, amount);
      setStatus({ kind: "done", hash });
      fetch("/api/after-sale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ promo }) }).catch(() => {});
    } catch (e) {
      setStatus({ kind: "error", text: friendly((e as Error).message) });
    }
  }

  async function payOtherWallet() {
    try {
      setStatus({ kind: "working", text: "Connecting wallet…" });
      const { address, client } = await connect();
      const bal = (await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] })) as bigint;
      if (bal < amount) throw new Error(`This wallet has $${(Number(bal) / 1e6).toFixed(2)} USDC on Arc. You need $${priceUsd.toFixed(2)}.`);
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
      setStatus({ kind: "done", hash: j.hash });
    } catch (e) {
      setStatus({ kind: "error", text: friendly((e as Error).message) });
    }
  }

  const label = closed ? "Closed at kickoff" : `Buy as a ${team} fan · $${priceUsd.toFixed(2)}`;
  return (
    <div className="checkout">
      {circleEnabled() ? (
        <button className="pay" disabled={closed || !acct || status.kind === "working"} onClick={payCircle} title={acct ? "" : "Create your wallet above first"}>
          {label}
        </button>
      ) : (
        <button className="pay" disabled={closed || status.kind === "working"} onClick={payOtherWallet}>
          {label}
        </button>
      )}
      <p className="fine">
        {product}. If {team} win, ${back} ({rateBps / 100}%) comes back to your wallet automatically after the final whistle.
      </p>
      {circleEnabled() && !closed && (
        <button className="link" onClick={payOtherWallet} disabled={status.kind === "working"}>
          or pay with MetaMask / Rabby
        </button>
      )}
      {status.kind === "working" && <p className="status">{status.text}</p>}
      {status.kind === "error" && <p className="status err">{status.text}</p>}
      {status.kind === "done" && (
        <p className="status ok">
          Paid. <a href={explorerTx(status.hash)} target="_blank" rel="noreferrer">View on Arc explorer</a>
        </p>
      )}
    </div>
  );
}

function friendly(msg: string) {
  if (/OverCap/i.test(msg)) return "This side is full at the current offer. Try the other side.";
  if (/OneSidePerWallet/i.test(msg)) return "This wallet already backed the other team in this promo.";
  if (/Closed/i.test(msg)) return "This promo closed at kickoff.";
  if (/NotAllowed|abort|cancel/i.test(msg)) return "Cancelled.";
  return msg.split("\n")[0];
}
