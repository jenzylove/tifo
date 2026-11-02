"use client";
// What to send once a drop is open: one message for a WhatsApp status or an Instagram story, and one personal message
// per saved customer, people due to buy again and fans of the clubs playing first. Each opens WhatsApp with the text
// typed in; the seller ticks who they have sent to.
import { useMemo, useState } from "react";
import { copyText } from "@/lib/copy";
import { generalMessage, personalMessage, prioritize, waLink, type DropForMessage } from "@/lib/customers";
import type { CustomersApi } from "./useCustomers";
import s from "./customers.module.css";

export interface PackDrop extends Omit<DropForMessage, "url"> {
  address: string;
}

export default function SharePack({ api, drop, onAddCustomers, compact }: { api: CustomersApi; drop: PackDrop; onAddCustomers?: () => void; compact?: boolean }) {
  const url = typeof location !== "undefined" ? `${location.origin}/p/${drop.address}` : `/p/${drop.address}`;
  const d: DropForMessage = { ...drop, url };
  const general = generalMessage(d);
  const [copied, setCopied] = useState("");
  const [all, setAll] = useState(false);
  const ranked = useMemo(() => prioritize(api.customers, { teams: [drop.teamA, drop.teamB], product: drop.product }), [api.customers, drop.teamA, drop.teamB, drop.product]);
  const sent = new Set(api.sent[drop.address.toLowerCase()] ?? []);
  const done = ranked.filter((r) => sent.has(r.customer.id)).length;
  const shown = all ? ranked : ranked.slice(0, 12);
  const copy = async (k: string, t: string) => setCopied((await copyText(t)) ? k : "failed");

  return (
    <div className={s.pack}>
      <div className={s.general}>
        <span className={s.label}>For your status or story</span>
        <p>{general}</p>
        <div className={s.actions}>
          <a className="btn sm" href={`https://wa.me/?text=${encodeURIComponent(general)}`} target="_blank" rel="noreferrer">
            Share on WhatsApp
          </a>
          <button className="btn sm ghost" onClick={() => copy("general", general)}>
            {copied === "general" ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      {!api.ready ? (
        <div className={s.lockline}>
          <span>Personal messages for each of your customers</span>
          <button className="link" disabled={!!api.busy} onClick={api.unlock}>
            {api.busy || "Open my customers"}
          </button>
        </div>
      ) : ranked.length === 0 ? (
        <div className={s.lockline}>
          <span>Add the people who bought before and I write each one a message.</span>
          {onAddCustomers && (
            <button className="link" onClick={onAddCustomers}>
              Add customers
            </button>
          )}
        </div>
      ) : (
        <>
          <div className={s.progress} aria-label={`${done} of ${ranked.length} sent`}>
            <span>
              {done} of {ranked.length} sent
            </span>
            <i style={{ ["--p" as string]: ranked.length ? done / ranked.length : 0 }} />
          </div>
          <ul className={s.people}>
            {shown.map(({ customer: c, due, fan }) => {
              const text = personalMessage(c, d, fan);
              const on = sent.has(c.id);
              return (
                <li key={c.id} className={on ? s.sent : ""}>
                  <details>
                    <summary>
                      <b>{c.name}</b>
                      <span className={s.tags}>
                        {fan && <em className={s.fan}>{fan} fan</em>}
                        {due && <em>due again</em>}
                      </span>
                    </summary>
                    <p className={s.msg}>{text}</p>
                  </details>
                  <div className={s.rowActions}>
                    {c.phone ? (
                      <a className="btn sm" href={waLink(c.phone, text)} target="_blank" rel="noreferrer" onClick={() => !on && api.toggleSent(drop.address, c.id, true)}>
                        {compact ? "Send" : "Send on WhatsApp"}
                      </a>
                    ) : (
                      <button className="btn sm ghost" onClick={() => copy(c.id, text)}>
                        {copied === c.id ? "Copied" : "Copy"}
                      </button>
                    )}
                    <button className={`${s.tick} ${on ? s.on : ""}`} role="switch" aria-checked={on} aria-label={on ? "Sent" : "Mark sent"} onClick={() => api.toggleSent(drop.address, c.id, !on)}>
                      <svg viewBox="0 0 16 16" aria-hidden>
                        <path d="M3 8.5l3 3 7-7" />
                      </svg>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {ranked.length > shown.length && (
            <button className="link fine" onClick={() => setAll(true)}>
              Show all {ranked.length}
            </button>
          )}
        </>
      )}
      {copied === "failed" && <p className="fine">This browser blocked copying. Press and hold the text to copy it.</p>}
      {api.error && <p className="status err">{api.error}</p>}
    </div>
  );
}
