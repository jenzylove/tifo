"use client";
// "Add money": Circle's Arc Onramp widget, opened over the page. The buyer pays by card, Apple Pay, Google Pay or bank
// transfer and the USDC lands in their own Tifo wallet on Arc, where the checkout is already watching the balance.
// Follows Arc's hosting rules: a sized container, a new tab where iframes break (iOS Safari), an iframe where popups
// break (Instagram, WhatsApp and other in-app browsers), a fresh session when one expires, and plain-word failures.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createOnrampKit, fetchOnrampSession, type OnrampSession } from "@circle-fin/onramp-kit";
import { ONRAMP_SANDBOX, ONRAMP_WIDGET, onrampReason, prefersWindow } from "@/lib/onramp";

type State = "loading" | "ready" | "submitted" | "settled" | "error" | "tab";

export default function CardTopUp({ address, amountUsd, onClose }: { address: string; amountUsd: number; onClose: (settled: boolean) => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  const widget = useRef<{ close: () => void } | null>(null);
  const session = useRef<OnrampSession | null>(null);
  const [state, setState] = useState<State>("loading");
  const [err, setErr] = useState("");
  const [round, setRound] = useState(0); // bump to start a fresh session
  const [amount] = useState(amountUsd); // fixed when opened, so a balance change does not restart the payment

  // The checkout re-renders every few seconds (balance polling); keep onClose in a ref so the widget is not remounted.
  const close = useRef(onClose);
  close.current = onClose;
  const kit = useRef(typeof window === "undefined" ? null : createOnrampKit({ widgetBaseUrl: ONRAMP_WIDGET }));
  const handlers = useCallback(
    (live: () => boolean) => ({
      onInitializationSuccess: () => live() && setState((s) => (s === "loading" ? "ready" : s)),
      onInitializationError: (e: { code: string; payload?: { errorMessage?: string } }) => {
        if (!live()) return;
        setErr(onrampReason(e.code, e.payload?.errorMessage) ?? "");
        setState("error");
      },
      onDepositSubmitted: () => live() && setState("submitted"),
      onDepositSettled: () => live() && setState("settled"),
      onDepositNotCompleted: (e: { code: string; payload?: { errorMessage?: string } }) => {
        if (!live()) return;
        const why = onrampReason(e.code, e.payload?.errorMessage);
        if (why === null) return close.current(false);
        setErr(why);
        setState("error");
      },
      onSessionExpired: () => live() && setRound((r) => r + 1),
    }),
    [],
  );

  useEffect(() => {
    let live = true;
    const alive = () => live;
    setState("loading");
    setErr("");
    (async () => {
      try {
        const s = await fetchOnrampSession({
          url: "/api/onramp/sessions",
          body: { appUserId: address.toLowerCase(), destinationAddress: address, amount: amount.toFixed(2), currency: "USD", assets: { pairs: [{ token: "USDC", chain: "arc" }] } },
        });
        if (!live) return;
        session.current = s;
        // iOS Safari: the identity check can fail inside an iframe, so offer a new tab (it needs a fresh tap).
        if (prefersWindow()) return setState("tab");
        if (!box.current || !kit.current) return;
        widget.current = kit.current.mountIframe({ session: s, container: box.current, ...handlers(alive) });
      } catch (e) {
        if (!live) return;
        setErr((e as Error).message?.split("\n")[0] || "Card payments could not start.");
        setState("error");
      }
    })();
    return () => {
      live = false;
      widget.current?.close();
      widget.current = null;
    };
  }, [address, amount, round, handlers]);

  /** Must run straight from a tap: no await before openWindow, or the browser blocks the tab. */
  function openTab() {
    if (!session.current || !kit.current) return;
    widget.current?.close();
    const r = kit.current.openWindow({ session: session.current, ...handlers(() => true) });
    if (r.status === "opened") {
      widget.current = r.widget;
      setState("ready");
    } else if (box.current) {
      // Popups do not work here (in-app browser, installed app, or a blocker): show it on the page instead.
      widget.current = kit.current.mountIframe({ session: session.current, container: box.current, ...handlers(() => true) });
      setState("loading");
    }
  }

  if (typeof document === "undefined") return null;
  const done = state === "settled";
  return createPortal(
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Add money">
      <div className="sheet-card">
        <header>
          <b>{done ? "Money added" : state === "submitted" ? "Payment sent" : "Add money"}</b>
          <button className="link" onClick={() => onClose(done || state === "submitted")}>
            {done || state === "submitted" ? "Continue" : "Close"}
          </button>
        </header>
        {ONRAMP_SANDBOX && <p className="fine">Test mode: use any 6 digit code (not 000000), any photo with a face, and no real card.</p>}
        {state === "loading" && <div className="skeleton" style={{ height: 22 }} />}
        {state === "error" && (
          <>
            <p className="status err">{err}</p>
            <button className="btn sm ghost" onClick={() => setRound((r) => r + 1)}>Try again</button>
          </>
        )}
        {state === "tab" && (
          <>
            <p className="fine">The payment opens in a new tab on this phone. Come back here when it is done.</p>
            <button className="btn block" onClick={openTab}>Open payment</button>
          </>
        )}
        {state === "submitted" && <p className="status ok">Payment sent. Your USDC usually arrives within a few minutes, and this page buys as soon as it lands.</p>}
        {done && <p className="status ok">Your balance is updating. Close this and confirm your order.</p>}
        <div ref={box} className="sheet-frame" hidden={state === "error" || state === "tab" || done} />
        {(state === "ready" || state === "loading") && !prefersWindow() && (
          <button className="link fine" onClick={openTab}>Not loading? Open it in a new tab</button>
        )}
        <p className="fine">Pay by card or bank transfer in your own currency. Payments are run by Circle and its partner. Tifo never sees your card or bank details.</p>
      </div>
    </div>,
    document.body,
  );
}
