"use client";
// The seller's own customers, optional. Paste a list, drop in a WhatsApp chat export or a screenshot of orders, and the
// agent pulls out names, numbers, what they bought and their club. When a drop is open, each one gets a message.
import { useState } from "react";
import type { SmartAccount } from "viem/account-abstraction";
import { cycleDays, lastPurchase, newId, normalizePhone, type Customer } from "@/lib/customers";
import type { ManagerData } from "@/lib/manager";
import { shortTeam } from "@/lib/matches";
import SharePack from "./SharePack";
import { shrinkImage, useCustomers, type CustomersApi } from "./useCustomers";
import s from "./customers.module.css";

type Source = "paste" | "chat" | "shot";

export default function Customers({ acct, data }: { acct: SmartAccount; data: ManagerData }) {
  const api = useCustomers(acct);
  const open = data.drops.filter((d) => d.phase === "open");
  return (
    <>
      <div className="mgr-head">
        <div>
          <h1>Customers</h1>
          <p className="muted">Optional. Add the people who bought from you before, and your agent writes each one a WhatsApp message when a drop opens.</p>
        </div>
      </div>

      {!api.ready ? (
        <div className={s.locked}>
          <span className="orb" />
          <p>Your list is private. Only you can open it, and numbers never go on chain.</p>
          <button className="btn" disabled={!!api.busy} onClick={api.unlock}>
            {api.busy || "Open my customers"}
          </button>
          {api.error && <p className="status err">{api.error}</p>}
        </div>
      ) : (
        <>
          {open.length > 0 && (
            <section className={s.section}>
              <h3>Send your open {open.length === 1 ? "drop" : "drops"}</h3>
              {open.map((d, i) => (
                <details key={d.address} className={s.acc} open={i === 0}>
                  <summary>
                    <b>{d.meta.product}</b>
                    <span>
                      {shortTeam(d.meta.teamA)} v {shortTeam(d.meta.teamB)} · {(api.sent[d.address.toLowerCase()] ?? []).length} sent
                    </span>
                  </summary>
                  <SharePack
                    api={api}
                    drop={{ address: d.address, shop: d.meta.shop, product: d.meta.product, teamA: d.meta.teamA, teamB: d.meta.teamB, backBps: d.meta.backBps ?? 5_000, kickoff: d.meta.kickoff }}
                  />
                </details>
              ))}
            </section>
          )}
          <Importer api={api} shop={data.name} />
          <List api={api} product={data.drops[0]?.meta.product ?? ""} />
        </>
      )}
    </>
  );
}

function Importer({ api, shop }: { api: CustomersApi; shop: string | null }) {
  const [src, setSrc] = useState<Source>("paste");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  async function go() {
    setNote("");
    let body: Parameters<CustomersApi["importFrom"]>[0] = { shop };
    if (src === "paste") body.text = text;
    else if (src === "chat" && file) body.text = (await file.text()).slice(-400_000);
    else if (src === "shot" && file) body = { shop, image: await shrinkImage(file) };
    const r = await api.importFrom(body);
    if (r) {
      setNote(r.found ? `Found ${r.found}. ${r.added} new on your list.` : "I could not find any customers in that.");
      setText("");
      setFile(null);
    }
  }
  const ready = src === "paste" ? !!text.trim() : !!file;
  return (
    <details className={`${s.acc} ${s.importer}`} open={api.customers.length === 0}>
      <summary>
        <b>Add customers</b>
        <span>a list, a WhatsApp chat, or a screenshot</span>
      </summary>
      <div className={s.importBody}>
        <div className="seg three">
          <button className={src === "paste" ? "on" : ""} onClick={() => setSrc("paste")}>Paste a list</button>
          <button className={src === "chat" ? "on" : ""} onClick={() => { setSrc("chat"); setFile(null); }}>Chat export</button>
          <button className={src === "shot" ? "on" : ""} onClick={() => { setSrc("shot"); setFile(null); }}>Screenshot</button>
        </div>
        {src === "paste" && (
          <textarea className="input" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Ada 0803 123 4567, shea butter in May\nTunde +234 805 555 1234 (Arsenal)"} />
        )}
        {src === "chat" && (
          <label className={s.drop}>
            <input type="file" accept=".txt,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <span>{file ? file.name : "Choose the .txt file"}</span>
            <small>In WhatsApp: open the chat, More, Export chat, Without media.</small>
          </label>
        )}
        {src === "shot" && (
          <label className={s.drop}>
            <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <span>{file ? file.name : "Choose a screenshot of your orders"}</span>
            <small>Read once and not kept.</small>
          </label>
        )}
        <button className="btn sm" disabled={!ready || !!api.busy} onClick={go}>
          {api.busy || "Read them"}
        </button>
        {note && <p className="status ok">{note}</p>}
        {api.error && <p className="status err">{api.error}</p>}
      </div>
    </details>
  );
}

const ago = (iso?: string) => {
  if (!iso) return null;
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d < 1 ? "today" : d < 60 ? `${d} days ago` : `${Math.round(d / 30)} months ago`;
};

function List({ api, product }: { api: CustomersApi; product: string }) {
  const [q, setQ] = useState("");
  const cycle = cycleDays(product);
  const list = api.customers.filter((c) => !q || `${c.name} ${c.phone ?? ""} ${c.club ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const update = (c: Customer) => api.save(api.customers.map((x) => (x.id === c.id ? c : x)));
  const remove = (id: string) => api.save(api.customers.filter((x) => x.id !== id));
  const add = () =>
    api.save([{ id: newId(), name: "New customer", phone: null, purchases: [], source: "manual", addedAt: Math.floor(Date.now() / 1000) }, ...api.customers]);
  return (
    <section className={s.section}>
      <h3>
        <span>
          Your customers <small className={s.count}>{api.customers.length}</small>
        </span>
        <button className="link fine" onClick={add} disabled={!!api.busy}>
          + Add one
        </button>
      </h3>
      {api.customers.length > 8 && <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name, number or club" />}
      {api.customers.length === 0 ? (
        <p className="empty">No customers yet. Add them above, or skip this: drops work without them.</p>
      ) : (
        <ul className={s.people}>
          {list.map((c) => (
            <Row key={c.id} c={c} cycle={cycle} onSave={update} onDelete={() => remove(c.id)} busy={!!api.busy} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({ c, cycle, onSave, onDelete, busy }: { c: Customer; cycle: number; onSave: (c: Customer) => void; onDelete: () => void; busy: boolean }) {
  const [name, setName] = useState(c.name);
  const [phone, setPhone] = useState(c.phone ?? "");
  const [club, setClub] = useState(c.club ?? "");
  const lp = lastPurchase(c);
  const since = lp?.at ? (Date.now() - Date.parse(lp.at)) / 86_400_000 : null;
  const due = since !== null && since >= cycle * 0.8;
  const bad = phone.trim() !== "" && !normalizePhone(phone);
  return (
    <li>
      <details>
        <summary>
          <b>{c.name}</b>
          <span className={s.tags}>
            {c.club && <em className={s.fan}>{c.club}</em>}
            {due && <em>due again</em>}
            {!c.phone && <em className={s.warn}>no number</em>}
          </span>
          <small className={s.meta}>
            {[c.phone, lp?.item, ago(lp?.at)].filter(Boolean).join(" · ")}
          </small>
        </summary>
        <div className={s.edit}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" placeholder="Name" />
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="WhatsApp number" placeholder="WhatsApp number" inputMode="tel" />
          <input className="input" value={club} onChange={(e) => setClub(e.target.value)} aria-label="Club" placeholder="Club they support" />
          {bad && <small className="status err">That number does not look right.</small>}
          <div className={s.actions}>
            <button
              className="btn sm"
              disabled={busy || bad || !name.trim()}
              onClick={() => onSave({ ...c, name: name.trim(), phone: phone.trim() ? normalizePhone(phone) : null, club: club.trim() || undefined })}
            >
              Save
            </button>
            <button className="btn sm ghost" disabled={busy} onClick={onDelete}>
              Delete
            </button>
          </div>
        </div>
      </details>
    </li>
  );
}
