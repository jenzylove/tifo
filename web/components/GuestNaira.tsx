"use client";
// Pay in naira with no wallet: the buyer gives a WhatsApp number, sees the naira price for their order, and goes to the
// Bachs page on this same tab (in app browsers handle new tabs badly). Bachs brings them back to /naira/paid, where the
// order is finished on chain by the server. Nothing here decides whether money moves; the server asks Bachs itself.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const naira = (ngn: string) => `₦${Number(ngn).toLocaleString("en-US")}`;

export const guestKey = (promo: string) => `tifo.guest.${promo.toLowerCase()}`;

export default function GuestNaira({ promo, side, qty, team, offer, referrer, onClose }: { promo: string; side: 0 | 1; qty: number; team: string; offer: string; referrer?: string | null; onClose: () => void }) {
  const [phone, setPhone] = useState("");
  const [quote, setQuote] = useState<{ ngn: string; busy: boolean } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "off" | "starting">("loading");
  const [err, setErr] = useState("");

  useEffect(() => {
    try {
      setPhone(localStorage.getItem("tifo.guest.phone") ?? "");
    } catch {
      // storage blocked: the buyer types it
    }
  }, []);

  useEffect(() => {
    let live = true;
    setState("loading");
    fetch(`/api/naira/guest/start?promo=${promo}&qty=${qty}`)
      .then((r) => r.json())
      .then((j) => {
        if (!live) return;
        if (!j.enabled) return setState("off");
        setQuote(j.ngn ? { ngn: j.ngn, busy: !!j.busy } : null);
        setState(j.ngn ? "ready" : "off");
        if (j.busy && !j.ngn) setQuote({ ngn: "", busy: true });
      })
      .catch(() => live && setState("off"));
    return () => {
      live = false;
    };
  }, [promo, qty]);

  async function pay() {
    setErr("");
    setState("starting");
    try {
      const r = await fetch("/api/naira/guest/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, promo, side, qty, ...(referrer ? { referrer } : {}) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.error ?? "Naira checkout could not start. Nothing was charged.");
        if (j.code === "busy") setQuote((q) => (q ? { ...q, busy: true } : q));
        return setState("ready");
      }
      try {
        localStorage.setItem("tifo.guest.phone", phone);
        localStorage.setItem(guestKey(promo), JSON.stringify({ id: j.checkoutId, at: Date.now() }));
      } catch {
        // storage blocked: Bachs still brings the buyer back to their order
      }
      location.href = j.checkoutUrl;
    } catch {
      setErr("Naira checkout could not start. Nothing was charged. Try again.");
      setState("ready");
    }
  }

  if (typeof document === "undefined") return null;
  const busy = !!quote?.busy;
  return createPortal(
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Pay in naira">
      <div className="sheet-card">
        <header>
          <b>Pay in naira</b>
          <button className="link" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="fine">{offer}. No wallet needed.</p>

        {state === "loading" && <div className="skeleton" style={{ height: 22 }} />}
        {state === "off" && <p className="status err">{busy ? "Naira checkout is busy. Try again in a few minutes." : "Naira checkout is not available for this drop. Pay another way."}</p>}

        {(state === "ready" || state === "starting") && quote && (
          <>
            {quote.ngn && <p className="naira-amount">{naira(quote.ngn)}</p>}
            <p className="fine">Bank transfer or card. Charges included.</p>
            <label className="field">
              Your WhatsApp number
              <input
                className="input"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="0803 123 4567"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
              <small>Your order is saved to this number. If {team} win, your money back is held for you at this number and you can collect it to your bank.</small>
            </label>
            {busy ? (
              <p className="status">Naira checkout is busy. Try again in a few minutes.</p>
            ) : (
              <button className="btn block" disabled={state === "starting" || phone.replace(/\D/g, "").length < 10} onClick={pay}>
                {state === "starting" ? "Opening…" : quote.ngn ? `Pay ${naira(quote.ngn)}` : "Pay in naira"}
              </button>
            )}
            <p className="fine">Opens a secure Bachs page. You come back here when you have paid.</p>
          </>
        )}
        {err && <p className="status err">{err}</p>}
      </div>
    </div>,
    document.body,
  );
}
