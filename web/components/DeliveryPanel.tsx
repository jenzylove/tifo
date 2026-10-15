"use client";
// Physical drops hold the seller's share of each sale until the buyer has the product. This panel shows the
// signed-in buyer their own orders ("I got it" / "It didn't arrive") and the seller the orders still to send.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Address } from "viem";
import { useAccount } from "@/lib/account";
import { explorerAddr, publicClient } from "@/lib/chain";
import { deliveryWithCircle, walletError } from "@/lib/circleWallet";
import { handleTap, type Retry } from "@/lib/tap";

export interface DeliveryRow {
  i: number;
  buyer: string;
  amount: string; // display
  at: number;
  state: "None" | "Held" | "Sent" | "Disputed" | "Released" | "Refunded";
  sentAt: number;
  tracking: string;
}

const day = (t: number) => new Date(t * 1000).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function DeliveryPanel({ promo, seller, holdSecs, rows, shop }: { promo: Address; seller: Address; holdSecs: number; rows: DeliveryRow[]; shop: string }) {
  const acct = useAccount();
  const router = useRouter();
  const [isSeller, setIsSeller] = useState(false);
  const [tracking, setTracking] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [retry, setRetry] = useState<Retry>(null);
  const days = Math.round(holdSecs / 86_400);

  // The seller is either the wallet that opened the drop, or the owner of the Tifo account that opened it.
  useEffect(() => {
    if (!acct) return setIsSeller(false);
    const me = acct.address.toLowerCase();
    if (me === seller.toLowerCase()) return setIsSeller(true);
    publicClient
      .readContract({ address: seller, abi: [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], functionName: "owner" })
      .then((o) => setIsSeller(String(o).toLowerCase() === me))
      .catch(() => setIsSeller(false));
  }, [acct, seller]);

  const mine = acct ? rows.filter((r) => r.buyer.toLowerCase() === acct.address.toLowerCase()) : [];
  const toSend = rows.filter((r) => r.state === "Held");
  const others = rows.filter((r) => r.state !== "Held");

  async function act(i: number, step: "markSent" | "confirmReceived" | "dispute") {
    if (!acct) return;
    if (step === "markSent" && !(tracking[i] ?? "").trim()) return setMsg({ ok: false, text: "Add the courier and tracking number or rider's phone first." });
    setBusy(i);
    setMsg(null);
    const done = (hash: string) => {
      setMsg({ ok: true, text: step === "markSent" ? "Marked sent. The buyer can see the tracking now." : step === "confirmReceived" ? `Thanks. ${shop} has been paid.` : "Reported. The Tifo team will look at it before anything is paid out." });
      setBusy(null);
      void hash;
      router.refresh();
    };
    const fail = (text: string) => {
      setMsg({ ok: false, text });
      setBusy(null);
    };
    try {
      done(await deliveryWithCircle(acct, promo, step, i, tracking[i]?.trim()));
    } catch (e) {
      if (handleTap<string>(e, done, fail, setRetry)) return setBusy(null);
      fail(walletError(e));
    }
  }

  if (!isSeller && mine.length === 0) {
    return (
      <p className="fine delivery-note">
        Paid for a physical product? Your money waits in this drop until you have it. {shop} is paid when you confirm, or {days} days after they mark it sent.
      </p>
    );
  }

  return (
    <section className="delivery panel">
      <h3>{isSeller ? "Orders to deliver" : "Your delivery"}</h3>
      {isSeller && <p className="fine">You are the seller. Send each order, then paste the courier and tracking link (or the rider's phone) so the buyer can follow it.</p>}

      {!isSeller &&
        mine.map((r) => (
          <div key={r.i} className="dl-row">
            <div>
              <b>Order {r.i + 1}</b> · {r.amount} · {day(r.at)}
              <small>
                {r.state === "Held" && `Waiting for ${shop} to send it. If it is not marked sent by ${day(r.at + holdSecs)}, your money comes back by itself.`}
                {r.state === "Sent" && `Sent: ${r.tracking}. ${shop} is paid when you confirm, or on ${day(r.sentAt + holdSecs)} if you say nothing.`}
                {r.state === "Disputed" && "You reported a problem. The Tifo team decides before anything is paid out."}
                {r.state === "Released" && `Delivered. ${shop} has been paid.`}
                {r.state === "Refunded" && "Your money was returned."}
              </small>
            </div>
            {(r.state === "Held" || r.state === "Sent") && (
              <div className="dl-actions">
                <button className="btn sm" disabled={busy !== null} onClick={() => act(r.i, "confirmReceived")}>
                  I got it
                </button>
                {r.state === "Sent" && (
                  <button className="btn sm ghost" disabled={busy !== null} onClick={() => act(r.i, "dispute")}>
                    It didn&apos;t arrive
                  </button>
                )}
              </div>
            )}
          </div>
        ))}

      {isSeller && (
        <>
          {toSend.length === 0 && <p className="fine">Nothing waiting to be sent.</p>}
          {toSend.map((r) => (
            <div key={r.i} className="dl-row">
              <div>
                <b>Order {r.i + 1}</b> · {r.amount} · buyer {short(r.buyer)}
                <small>Mark it sent by {day(r.at + holdSecs)}, or the buyer gets the money back.</small>
              </div>
              <div className="dl-actions">
                <input
                  className="input"
                  placeholder="Courier and tracking, e.g. Chowdeck CHW-123"
                  value={tracking[r.i] ?? ""}
                  onChange={(e) => setTracking((t) => ({ ...t, [r.i]: e.target.value }))}
                  maxLength={120}
                />
                <button className="btn sm" disabled={busy !== null} onClick={() => act(r.i, "markSent")}>
                  {busy === r.i ? "Saving…" : "Mark sent"}
                </button>
              </div>
            </div>
          ))}
          {others.length > 0 && (
            <details>
              <summary className="fine">Sent and settled ({others.length})</summary>
              {others.map((r) => (
                <p key={r.i} className="fine">
                  Order {r.i + 1} · {r.amount} · {r.state === "Sent" ? `sent (${r.tracking}), paid on ${day(r.sentAt + holdSecs)} unless confirmed sooner` : r.state.toLowerCase()}
                </p>
              ))}
            </details>
          )}
        </>
      )}

      {retry && (
        <button className="btn block" onClick={retry}>
          Confirm
        </button>
      )}
      {msg && <p className={`status ${msg.ok ? "ok" : "err"}`}>{msg.text}</p>}
      <p className="fine">
        The money for each order waits in the drop&apos;s contract, not with Tifo.{" "}
        <a href={explorerAddr(promo)} target="_blank" rel="noreferrer">
          See it on the explorer
        </a>
      </p>
    </section>
  );
}
