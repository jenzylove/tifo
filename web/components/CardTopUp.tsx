"use client";
// "Pay with card": Circle's Arc Onramp widget, opened over the page. The buyer pays by card, Apple Pay or
// Google Pay and the USDC lands in their own Tifo wallet on Arc, where the checkout is already watching the balance.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createOnrampKit, fetchOnrampSession } from "@circle-fin/onramp-kit";

export default function CardTopUp({ address, amountUsd, onClose }: { address: string; amountUsd: number; onClose: (settled: boolean) => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "settled" | "error">("loading");
  const [err, setErr] = useState("");

  useEffect(() => {
    let widget: { close: () => void } | undefined;
    let live = true;
    (async () => {
      try {
        const session = await fetchOnrampSession({
          url: "/api/onramp/sessions",
          body: { appUserId: address.toLowerCase(), destinationAddress: address, amount: amountUsd.toFixed(2), currency: "USD", assets: { pairs: [{ token: "USDC", chain: "arc" }] } },
        });
        if (!live || !box.current) return;
        widget = createOnrampKit().mountIframe({
          session,
          container: box.current,
          onInitializationSuccess: () => live && setState("ready"),
          onDepositSettled: () => live && setState("settled"),
        });
      } catch (e) {
        if (!live) return;
        setErr((e as Error).message?.split("\n")[0] || "Card payments could not start.");
        setState("error");
      }
    })();
    return () => {
      live = false;
      widget?.close();
    };
  }, [address, amountUsd]);

  // Rendered on the page body: an animated parent would otherwise trap a fixed overlay inside itself.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Pay with card">
      <div className="sheet-card">
        <header>
          <b>{state === "settled" ? "Money added" : "Pay with card"}</b>
          <button className="link" onClick={() => onClose(state === "settled")}>
            {state === "settled" ? "Continue" : "Close"}
          </button>
        </header>
        {state === "loading" && <div className="skeleton" style={{ height: 22 }} />}
        {state === "error" && <p className="status err">{err}</p>}
        {state === "settled" && <p className="status ok">Your balance is updating. Close this and tap Buy.</p>}
        <div ref={box} className="sheet-frame" hidden={state === "error"} />
        <p className="fine">Card payments are run by Circle and its partner. Tifo never sees your card.</p>
      </div>
    </div>,
    document.body,
  );
}
