"use client";
// "Pay in naira": the buyer pays naira (bank transfer or card) on a Bachs page that opens in a new tab. When Bachs confirms,
// our server sends the matching USDC to their own Tifo wallet on Arc, where the checkout is already watching the balance.
// This sheet shows the price, opens the Bachs page, then asks the server every 5 seconds whether the payment has landed.
// The server asks Bachs itself each time, so nothing here decides whether money moves.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type State = "loading" | "ready" | "starting" | "waiting" | "received" | "paused" | "error";
type Note = "" | "unpaid" | "short" | "stopped";

const POLL_MS = 5_000;
const GIVE_UP_MS = 30 * 60_000; // a Bachs checkout lasts 30 minutes

const naira = (ngn: string) => `₦${Number(ngn).toLocaleString("en-US")}`;
const money = (n: number) => `$${n.toFixed(2)}`;

export default function NairaTopUp({ address, promo, amountUsd, onClose }: { address: string; promo: string; amountUsd: number; onClose: () => void }) {
  // Fixed when opened, so a balance change does not move the price. Rounded up to the cent, like the server does.
  const [amount] = useState(() => Math.ceil(Math.round(amountUsd * 1e6) / 1e4) / 100);
  const [state, setState] = useState<State>("loading");
  const [quote, setQuote] = useState<{ ngn: string; rate: number } | null>(null);
  const [err, setErr] = useState("");
  const [paying, setPaying] = useState<{ id: string; url: string } | null>(null);
  const [note, setNote] = useState<Note>("");

  useEffect(() => {
    let live = true;
    fetch(`/api/naira/start?usd=${amount}`)
      .then((r) => r.json())
      .then((j) => {
        if (!live) return;
        if (!j.enabled || !j.ngn) return setState("paused");
        if (amount > j.maxUsd) {
          setErr(`The most you can add in naira at once is ${money(j.maxUsd)}. Add less here, or pay another way.`);
          return setState("error");
        }
        setQuote({ ngn: j.ngn, rate: j.rate });
        setState("ready");
      })
      .catch(() => {
        if (!live) return;
        setErr("Naira payments could not load. Check your connection and try again.");
        setState("error");
      });
    return () => {
      live = false;
    };
  }, [amount]);

  // Once the Bachs page is open, ask every 5 seconds until the USDC is sent, or 30 minutes pass, or the sheet closes.
  useEffect(() => {
    if (!paying) return;
    const from = Date.now();
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!live) return;
      if (Date.now() - from > GIVE_UP_MS) return setNote("stopped");
      try {
        const r = await fetch("/api/naira/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ checkoutId: paying.id }) });
        const j = r.ok ? await r.json() : null;
        if (!live) return;
        if (j?.state === "released" || j?.state === "already") return setState("received");
        setNote(j?.state === "float_short" ? "short" : j?.state === "not_paid" ? "unpaid" : "");
      } catch {
        // a dropped request is not news: the next check is five seconds away
      }
      if (live) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [paying]);

  function open(url: string) {
    // In a browser that blocks the new tab, go to Bachs on this tab. It sends the buyer back to this page when done.
    if (!window.open(url, "_blank")) location.href = url;
  }

  async function start() {
    setState("starting");
    setErr("");
    try {
      const r = await fetch("/api/naira/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: address, usd: amount, promo }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.error ?? "Naira payments could not start. Nothing was charged.");
        return setState(r.status === 503 ? "paused" : "error");
      }
      setQuote({ ngn: j.ngn, rate: j.rate });
      setPaying({ id: j.checkoutId, url: j.checkoutUrl });
      setState("waiting");
      open(j.checkoutUrl);
    } catch {
      setErr("Naira payments could not start. Nothing was charged. Try again.");
      setState("error");
    }
  }

  if (typeof document === "undefined") return null;
  const done = state === "received";
  return createPortal(
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Pay in naira">
      <div className="sheet-card">
        <header>
          <b>{done ? "Payment received" : "Pay in naira"}</b>
          <button className="link" onClick={onClose}>
            {done ? "Continue" : "Close"}
          </button>
        </header>

        {state === "loading" && <div className="skeleton" style={{ height: 22 }} />}

        {(state === "ready" || state === "starting") && quote && (
          <>
            <p className="naira-amount">{naira(quote.ngn)}</p>
            <p className="fine">Bank transfer or card. Charges included.</p>
            <button className="btn block" disabled={state === "starting"} onClick={start}>
              {state === "starting" ? "Opening…" : `Continue to pay ${naira(quote.ngn)}`}
            </button>
            <p className="fine">Opens a secure Bachs page in a new tab.</p>
          </>
        )}

        {state === "waiting" && paying && (
          <>
            {note === "" && <p className="status">Waiting for your payment. Finish it on the Bachs page, and this page carries on by itself.</p>}
            {note === "unpaid" && <p className="status err">That payment has not gone through yet. You can open the payment page and try again, or pay another way.</p>}
            {note === "short" && <p className="status">Naira payments are paused right now. If you already paid, keep this page open and your money is sent as soon as they are back. Or pay another way.</p>}
            {note === "stopped" && <p className="status">We stopped checking after 30 minutes. If you paid, your balance updates once the payment is confirmed.</p>}
            <button className="link fine" onClick={() => open(paying.url)}>
              Open the payment page again
            </button>
          </>
        )}

        {done && <p className="status ok">Payment received. Your order goes through in a moment.</p>}

        {state === "paused" && <p className="status err">Naira payments are paused right now. Pay another way.</p>}

        {state === "error" && (
          <>
            <p className="status err">{err}</p>
            {quote && (
              <button className="btn sm ghost" onClick={() => setState("ready")}>
                Try again
              </button>
            )}
          </>
        )}

      </div>
    </div>,
    document.body,
  );
}
