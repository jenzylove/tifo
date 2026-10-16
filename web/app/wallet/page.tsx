"use client";
// Your Tifo wallet: see which wallet this browser is using, its balance, switch to another passkey wallet,
// and send USDC out (to an exchange deposit address on Arc, or any wallet). Refunds land here after full time.
import { useEffect, useState } from "react";
import { isAddress, parseUnits, type Address } from "viem";
import { setAccount, useAccount } from "@/lib/account";
import { NETWORK, explorerAddr, explorerTx } from "@/lib/chain";
import { usePasskeyReady } from "@/lib/usePasskeyReady";
import { biometric, circleEnabled, connectCircle, preparePasskey, sendUsdcWithCircle, usdcBalance, walletError } from "@/lib/circleWallet";
import { handleTap, type Retry } from "@/lib/tap";

const money = (u: bigint) => `$${(Number(u) / 1e6).toFixed(2)}`;

export default function WalletPage() {
  const acct = useAccount();
  const [bio, setBio] = useState("Face ID or fingerprint");
  const ready = usePasskeyReady();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; hash?: string } | null>(null);
  const [retry, setRetry] = useState<Retry>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setBio(biometric());
    if (circleEnabled()) preparePasskey().catch(() => {});
  }, []);
  useEffect(() => {
    setBalance(null);
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

  async function open(mode: "login" | "register") {
    setBusy(true);
    setMsg(null);
    try {
      setAccount(await connectCircle(mode));
    } catch (e) {
      setMsg({ ok: false, text: walletError(e) });
    }
    setBusy(false);
  }

  async function send() {
    if (!acct || balance === null) return;
    if (!isAddress(to.trim())) return setMsg({ ok: false, text: "That is not a wallet address. It starts with 0x and has 42 characters." });
    let units: bigint;
    try {
      units = parseUnits(amount.trim() || "0", 6);
    } catch {
      return setMsg({ ok: false, text: "Type an amount like 1.50" });
    }
    if (units <= 0n) return setMsg({ ok: false, text: "Type an amount above zero." });
    if (units > balance) return setMsg({ ok: false, text: `You have ${money(balance)}.` });
    if (to.trim().toLowerCase() === acct.address.toLowerCase()) return setMsg({ ok: false, text: "That is this wallet's own address." });
    setBusy(true);
    setMsg(null);
    const done = (hash: string) => {
      setMsg({ ok: true, text: `Sent ${money(units)}.`, hash });
      setAmount("");
      setBusy(false);
    };
    const fail = (text: string) => {
      setMsg({ ok: false, text });
      setBusy(false);
    };
    try {
      done(await sendUsdcWithCircle(acct, to.trim() as Address, units));
    } catch (e) {
      if (handleTap<string>(e, done, fail, setRetry)) return setBusy(false);
      fail(walletError(e));
    }
  }

  return (
    <div className="wrap" style={{ maxWidth: 560 }}>
      <div className="pagehead">
        <span className="eyebrow">{NETWORK === "testnet" ? "Practice wallet (testnet)" : "Your Tifo wallet"}</span>
        <h1>Wallet</h1>
        <p>Refunds land here after full time. Send your USDC to an exchange or any wallet on the Arc network whenever you like.</p>
      </div>

      {!circleEnabled() ? (
        <p className="empty panel">Passkey wallets are not set up on this site.</p>
      ) : !acct ? (
        <section className="panel" style={{ display: "grid", gap: 10 }}>
          <button className="btn block" disabled={busy || !ready} onClick={() => open("login")}>
            {ready ? `Sign in with ${bio}` : "Getting ready…"}
          </button>
          <p className="fine">
            Your device shows every Tifo wallet saved on it. Pick the one you want. No wallet yet?{" "}
            <button className="link" disabled={!ready} onClick={() => open("register")}>Create one</button>
          </p>
        </section>
      ) : (
        <section className="panel" style={{ display: "grid", gap: 14 }}>
          <div className="mini-row">
            <span>Address</span>
            <b>
              <a href={explorerAddr(acct.address)} target="_blank" rel="noreferrer">
                <code>{acct.address.slice(0, 8)}…{acct.address.slice(-6)}</code>
              </a>{" "}
              <button
                className="link fine"
                onClick={() => {
                  navigator.clipboard?.writeText(acct.address);
                  setCopied(true);
                }}
              >
                {copied ? "copied" : "copy"}
              </button>
            </b>
          </div>
          <div className="mini-row">
            <span>Balance</span>
            <b style={{ fontSize: "1.6rem" }}>{balance === null ? "…" : money(balance)}</b>
          </div>
          <p className="fine">
            Not the wallet you expected?{" "}
            <button className="link" disabled={busy} onClick={() => open("login")}>
              Switch wallet
            </button>{" "}
            and pick another one your device saved.
          </p>

          <h3 style={{ margin: "8px 0 0" }}>Send USDC</h3>
          <input className="input" placeholder="To: 0x… address on the Arc network" value={to} onChange={(e) => setTo(e.target.value)} />
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" inputMode="decimal" placeholder="Amount, e.g. 1.50" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button className="btn sm ghost" disabled={!balance} onClick={() => balance !== null && setAmount((Number(balance) / 1e6).toFixed(2))}>
              Max
            </button>
          </div>
          <p className="fine">Only send to an address that accepts USDC on Arc. Exchanges show this when you choose the Arc network on their deposit page. Gas is covered.</p>
          {retry ? (
            <button className="btn block" onClick={retry}>
              Confirm with {bio}
            </button>
          ) : (
            <button className="btn block" disabled={busy || !to || !amount} onClick={send}>
              {busy ? "Sending…" : `Send with ${bio}`}
            </button>
          )}
        </section>
      )}
      {msg && (
        <p className={`status ${msg.ok ? "ok" : "err"}`}>
          {msg.text}{" "}
          {msg.hash && (
            <a href={explorerTx(msg.hash)} target="_blank" rel="noreferrer">
              Receipt
            </a>
          )}
        </p>
      )}
    </div>
  );
}
