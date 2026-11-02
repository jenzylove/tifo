"use client";
// "Collect your money back to your bank", for a guest buyer on /naira/paid. The server decides everything: what is held,
// the account name the bank resolved, and whether the transfer went. This only shows it and asks.
import { useCallback, useEffect, useState } from "react";

type View =
  | { can: "none" | "not_yet" }
  | { can: "held"; usd: string; ngn: string }
  | { can: "held_closed"; message: string }
  | { can: "ready"; usd: string; ngn: string }
  | { can: "confirm" | "waiting_bank"; usd: string; ngn: string; accountName: string; bankName: string; last4: string }
  | { can: "sending" | "paid"; ngn: string; accountName: string; bankName: string; last4: string }
  | { can: "failed"; usd: string; ngn: string; reason: string };

const naira = (n: string) => `₦${Number(n).toLocaleString("en-US")}`;
const HELD = "Money back is held safely for you at your Tifo number. Collecting to your bank opens soon.";

export default function MoneyBack({ checkoutId }: { checkoutId: string }) {
  const [v, setV] = useState<View | null>(null);
  const [banks, setBanks] = useState<{ name: string; code: string }[]>([]);
  const [bank, setBank] = useState("");
  const [acct, setAcct] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState(false);

  const call = useCallback(
    async (body: Record<string, unknown>) => {
      const r = await fetch("/api/naira/guest/payout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ checkoutId, ...body }) }).catch(() => null);
      const j = await r?.json().catch(() => null);
      if (r?.ok && j?.can) {
        setV(j as View);
        setErr("");
        return true;
      }
      if (j?.error) setErr(j.error);
      return false;
    },
    [checkoutId],
  );

  useEffect(() => {
    call({ action: "status" });
  }, [call]);

  // While the bank checks a new account, or the transfer is on its way, keep asking.
  useEffect(() => {
    if (v?.can !== "waiting_bank" && v?.can !== "sending") return;
    const t = setInterval(() => call({ action: "collect" }), v.can === "waiting_bank" ? 30_000 : 15_000);
    return () => clearInterval(t);
  }, [v?.can, call]);

  const needForm = v?.can === "ready" || v?.can === "failed" || edit;
  useEffect(() => {
    if (!needForm || banks.length) return;
    fetch("/api/naira/guest/payout")
      .then((r) => r.json())
      .then((j) => setBanks(Array.isArray(j.banks) ? j.banks : []))
      .catch(() => {});
  }, [needForm, banks.length]);

  if (!v || v.can === "none" || v.can === "not_yet") return null;
  if (v.can === "held" || v.can === "held_closed") {
    return (
      <div className="refer">
        <b>{v.can === "held" ? `${naira(v.ngn)} is yours` : "Your money back"}</b>
        <p className="fine">{HELD}</p>
      </div>
    );
  }
  if (v.can === "paid") {
    return (
      <div className="refer">
        <b>{naira(v.ngn)} sent to your bank</b>
        <p className="fine">
          To {v.accountName}, {v.bankName} ending {v.last4}.
        </p>
      </div>
    );
  }
  if (v.can === "sending" || v.can === "waiting_bank") {
    return (
      <div className="refer">
        <b>{v.can === "sending" ? `${naira(v.ngn)} is on its way` : "Your bank account is being checked"}</b>
        <p className="fine">
          To {v.accountName}, {v.bankName} ending {v.last4}. This page carries on by itself, and your money is safe meanwhile.
        </p>
      </div>
    );
  }

  async function check() {
    setBusy(true);
    setErr("");
    if (await call({ action: "account", bankCode: bank, accountNumber: acct.replace(/\D/g, "") })) setEdit(false);
    setBusy(false);
  }
  async function send() {
    setBusy(true);
    await call({ action: "collect" });
    setBusy(false);
  }

  if (v.can === "confirm" && !edit) {
    return (
      <div className="refer">
        <b>Send {naira(v.ngn)} to {v.accountName}?</b>
        <p className="fine">
          {v.bankName} ending {v.last4}. Check the name is yours before you send.
        </p>
        <button className="btn block" disabled={busy} onClick={send}>
          {busy ? "Sending…" : "Yes, send it"}
        </button>
        <button className="link fine" disabled={busy} onClick={() => setEdit(true)}>
          Not my account? Use another
        </button>
        {err && <p className="status err">{err}</p>}
      </div>
    );
  }

  const amount = "ngn" in v ? v.ngn : "";
  return (
    <div className="refer">
      <b>{amount ? `Collect ${naira(amount)} to your bank` : "Collect your money back"}</b>
      {v.can === "failed" && <p className="status err">The transfer to your bank did not go through. Your money is safe. Try another account.</p>}
      <label className="field">
        Bank
        <select className="input" value={bank} onChange={(e) => setBank(e.target.value)}>
          <option value="">{banks.length ? "Pick your bank" : "Loading banks…"}</option>
          {banks.map((b) => (
            <option key={b.code} value={b.code}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Account number
        <input className="input" inputMode="numeric" autoComplete="off" maxLength={10} placeholder="10 digits" value={acct} onChange={(e) => setAcct(e.target.value.replace(/\D/g, "").slice(0, 10))} />
      </label>
      <button className="btn block" disabled={busy || !bank || acct.length !== 10} onClick={check}>
        {busy ? "Checking…" : "Check account"}
      </button>
      {err && <p className="status err">{err}</p>}
    </div>
  );
}
