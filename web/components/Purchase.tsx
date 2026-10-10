"use client";
// A buyer's paid order on this device. For a digital product it opens what the seller sealed into the drop.
import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";

const key = (promo: string) => `tifo.order.${promo.toLowerCase()}`;

export interface SavedOrder {
  hash: Hex;
  secret: Hex;
}

export function saveOrder(promo: string, order: SavedOrder) {
  try {
    localStorage.setItem(key(promo), JSON.stringify(order));
  } catch {
    // private mode: the buyer still has the receipt
  }
}

export function savedOrder(promo: string): SavedOrder | null {
  try {
    return JSON.parse(localStorage.getItem(key(promo)) ?? "null");
  } catch {
    return null;
  }
}

const isLink = (s: string) => /^https?:\/\/\S+$/.test(s.trim());

export default function Purchase({ promo, product, order: given }: { promo: string; product: string; order?: SavedOrder }) {
  const [order, setOrder] = useState<SavedOrder | null>(given ?? null);
  const [delivery, setDelivery] = useState("");
  const [state, setState] = useState<"idle" | "opening" | "wait" | "err">("idle");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!given) setOrder(savedOrder(promo));
  }, [promo, given]);

  const open = useCallback(
    async (o: SavedOrder, tries = 6): Promise<void> => {
      setState("opening");
      const r = await fetch("/api/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ promo, ...o }) }).catch(() => null);
      const j = await r?.json().catch(() => null);
      if (r?.ok) {
        setDelivery(j.delivery);
        return setState("idle");
      }
      // The payment can take a few seconds to confirm, so a "not yet" is retried before it is shown.
      if (r?.status === 409 && tries > 0) {
        setState("wait");
        await new Promise((res) => setTimeout(res, 2500));
        return open(o, tries - 1);
      }
      setErr(j?.error ?? "Couldn't open it just now. Try again.");
      setState("err");
    },
    [promo],
  );

  // Straight after paying, open it without another tap.
  useEffect(() => {
    if (given) open(given);
  }, [given, open]);

  if (!order) return null;
  return (
    <div className="done" style={{ marginTop: 12 }}>
      <b>{delivery ? `Here is your ${product}` : `You bought ${product}`}</b>
      {delivery ? (
        isLink(delivery) ? (
          <a className="btn sm" href={delivery.trim()} target="_blank" rel="noreferrer">
            Open it
          </a>
        ) : (
          <p style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>{delivery}</p>
        )
      ) : (
        <button className="btn sm" disabled={state === "opening" || state === "wait"} onClick={() => open(order)}>
          {state === "opening" ? "Opening…" : state === "wait" ? "Confirming your payment…" : "Open your purchase"}
        </button>
      )}
      {state === "err" && <p className="status err">{err}</p>}
    </div>
  );
}
