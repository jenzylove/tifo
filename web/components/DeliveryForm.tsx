"use client";
// After paying for something the seller delivers: where it should go. Sealed for the seller; nobody else can read it.
import { useState } from "react";
import type { Hex } from "viem";

export default function DeliveryForm({ promo, order, shop, onDone }: { promo: string; order: { hash: Hex; secret: Hex }; shop: string; onDone?: () => void }) {
  const [f, setF] = useState({ name: "", phone: "", address: "", note: "" });
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function save() {
    setState("saving");
    setErr("");
    try {
      const r = await fetch("/api/delivery-info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ promo, ...order, ...f, note: f.note || undefined }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setState("saved");
      onDone?.();
    } catch (e) {
      setErr((e as Error).message);
      setState("idle");
    }
  }
  if (state === "saved") return <p className="status ok">Sent to {shop}. Only they can see your address. You will see the tracking here once they send it.</p>;
  const ready = f.name.trim().length >= 2 && f.phone.trim().length >= 6 && f.address.trim().length >= 6;
  return (
    <div className="dl-form">
      <b>Where should {shop} deliver it?</b>
      <input className="input" value={f.name} onChange={set("name")} placeholder="Your name" maxLength={80} autoComplete="name" />
      <input className="input" value={f.phone} onChange={set("phone")} placeholder="Phone number" maxLength={30} autoComplete="tel" inputMode="tel" />
      <textarea className="input" rows={2} value={f.address} onChange={set("address")} placeholder="Full delivery address" maxLength={300} autoComplete="street-address" />
      <input className="input" value={f.note} onChange={set("note")} placeholder="Anything else? Size, colour, best time (optional)" maxLength={300} />
      <button className="btn sm" disabled={!ready || state === "saving"} onClick={save}>
        {state === "saving" ? "Sending…" : "Send to " + shop}
      </button>
      {err && <p className="status err">{err}</p>}
      <p className="fine">Sealed for {shop} only. Your payment waits in the drop until you confirm you have it.</p>
    </div>
  );
}
