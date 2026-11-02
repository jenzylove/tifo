"use client";
// Where Bachs brings a guest buyer back after paying in naira. The page asks the server every few seconds; the server
// asks Bachs, sends the USDC to the buyer's Tifo number address and places the order on chain. Then this shows
// "Paid, your order is in" with the receipt, and how money back works for someone with no wallet.
import { useCallback, useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import Purchase, { saveOrder } from "./Purchase";
import DeliveryForm from "./DeliveryForm";
import MoneyBack from "./MoneyBack";
import { contactLink } from "./Checkout";
import { offerLabel, precheck } from "@/lib/precheck";

type Drop = { product: string; shop: string; teams: [string, string]; digital: boolean; contact?: string };
type Order = { promo: Address; side: 0 | 1; amount: string; rateBps: number; guest: Address };
type Answer = { state: string; order?: Order; drop?: Drop | null; tx?: Hex | null; txUrl?: string | null; secret?: Hex; reason?: string };

const POLL_MS = 5_000;
const GIVE_UP_MS = 30 * 60_000;
const money = (units: number) => `$${(units / 1e6).toFixed(2)}`;

export default function GuestOrderStatus({ checkoutId }: { checkoutId: string }) {
  const [a, setA] = useState<Answer | null>(null);
  const [stopped, setStopped] = useState(false);
  const [now, setNow] = useState<number | null>(null); // the offer right now, when the shown one moved
  const [working, setWorking] = useState(false);

  const ask = useCallback(
    async (accept?: number): Promise<Answer | null> => {
      const r = await fetch("/api/naira/guest/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkoutId, ...(accept !== undefined ? { accept } : {}) }),
      }).catch(() => null);
      if (!r?.ok) return null;
      const j = (await r.json().catch(() => null)) as Answer | null;
      if (j) setA(j);
      return j;
    },
    [checkoutId],
  );

  useEffect(() => {
    const from = Date.now();
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!live) return;
      const j = await ask();
      if (!live) return;
      if (j && ["done", "refund_due", "offer_moved"].includes(j.state)) return;
      if (Date.now() - from > GIVE_UP_MS) return setStopped(true);
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [ask]);

  // Once in: keep the order on this phone (so the drop page can open a digital product) and tell the agent a sale landed.
  useEffect(() => {
    if (a?.state !== "done" || !a.order) return;
    if (a.tx && a.secret) saveOrder(a.order.promo, { hash: a.tx, secret: a.secret });
    const k = `tifo.guest.told.${checkoutId}`;
    try {
      if (sessionStorage.getItem(k)) return;
      sessionStorage.setItem(k, "1");
    } catch {
      // storage blocked: telling the agent twice is harmless
    }
    fetch("/api/after-sale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ promo: a.order.promo, buyer: a.order.guest }) }).catch(() => {});
  }, [a, checkoutId]);

  useEffect(() => {
    if (a?.state !== "offer_moved" || !a.order || !a.drop) return;
    const o = a.order;
    precheck(o.promo, o.guest, o.side, BigInt(o.amount), a.drop.teams)
      .then((r) => setNow("rateBps" in r ? r.rateBps : null))
      .catch(() => {});
  }, [a]);

  const order = a?.order;
  const drop = a?.drop;
  const team = order && drop ? drop.teams[order.side] : "your club";

  if (!a || a.state === "pending" || a.state === "float_short" || a.state === "not_paid") {
    return (
      <div className="done">
        <b>{a?.state === "not_paid" ? "We have not seen your payment yet" : "Checking your payment"}</b>
        {a?.state === "not_paid" ? (
          <p className="fine">If you paid, it can take a few minutes for the bank to confirm. Keep this page open. If you did not pay, nothing was charged.</p>
        ) : a?.state === "float_short" ? (
          <p className="fine">Your payment is in. Naira checkout is busy, so your order goes through in a few minutes. Keep this page open, or come back to this link later.</p>
        ) : (
          <p className="fine">Your bank transfer can take a minute or two. This page carries on by itself.</p>
        )}
        {stopped && <p className="status">We stopped checking after 30 minutes. Refresh this page to check again. If you paid, your order is not lost.</p>}
        {!stopped && <div className="skeleton" style={{ height: 22 }} />}
      </div>
    );
  }

  if (a.state === "offer_moved" && order) {
    return (
      <div className="done">
        <b>Paid. One more tap</b>
        <p className="fine">
          While your transfer came in, other fans bought and the money back offer changed. Your money is safe and held for you.
          {now !== null && ` The offer now is: ${offerLabel(now, team)}.`}
        </p>
        <button
          className="btn block"
          disabled={working || now === null}
          onClick={async () => {
            setWorking(true);
            await ask(now ?? 0);
            setWorking(false);
          }}
        >
          {working ? "Placing your order…" : "Place my order at this offer"}
        </button>
        <p className="fine">Rather not? Message the shop and they send your money back.</p>
      </div>
    );
  }

  if (a.state === "refund_due") {
    return (
      <div className="done">
        <b>Paid, but the order could not go through</b>
        <p className="fine">
          {a.reason === "Closed" ? "The sale ended before your payment came in. " : ""}
          Your money is safe and held for you at your Tifo number. You can collect it to your bank below, or message the shop.
        </p>
        <MoneyBack checkoutId={checkoutId} />
        {drop && order && <ShopLink drop={drop} text={`Hi ${drop.shop}, I paid in naira on Tifo but my order did not go through. Checkout ${checkoutId}.`} />}
      </div>
    );
  }

  // done
  const back = order ? (Number(order.amount) * order.rateBps) / 10_000 : 0;
  return (
    <div className="done">
      <b>Paid, your order is in.</b>
      {order && drop && (
        <p className="fine">
          {drop.product} from {drop.shop}, on {team}.
        </p>
      )}
      <p className="fine">
        {back > 0
          ? `If ${team} win, ${money(back)} comes back to you after full time. It is held for you at your Tifo number, and you can collect it to your bank on this page after the match. Keep this link.`
          : "Your order is in. You keep what you bought either way."}
      </p>
      <MoneyBack checkoutId={checkoutId} />
      {order && drop?.digital && a.tx && a.secret && <Purchase promo={order.promo} product={drop.product} order={{ hash: a.tx, secret: a.secret }} />}
      {order && drop && !drop.digital && a.tx && a.secret && <DeliveryForm promo={order.promo} shop={drop.shop} order={{ hash: a.tx, secret: a.secret }} />}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {drop && <ShopLink drop={drop} text={`Hi ${drop.shop}, I just paid for ${drop.product} on Tifo.${a.txUrl ? ` Receipt: ${a.txUrl}` : ""}`} />}
        {a.txUrl && (
          <a className="btn sm ghost" href={a.txUrl} target="_blank" rel="noreferrer">
            Receipt
          </a>
        )}
        {order && (
          <a className="btn sm ghost" href={`/p/${order.promo}`}>
            Back to the drop
          </a>
        )}
      </div>
    </div>
  );
}

function ShopLink({ drop, text }: { drop: Drop; text: string }) {
  const c = contactLink(drop.contact, text);
  if (!c) return null;
  return (
    <a className="btn sm" href={c.href} target="_blank" rel="noreferrer">
      Message {drop.shop} on {c.via}
    </a>
  );
}
