"use client";
// Booking times in one tidy dropdown: grouped by day, in the buyer's own clock, booked times shown but not selectable.
import { useEffect, useMemo, useRef, useState } from "react";

type Slot = { i: number; at: string; taken: boolean };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export default function TimePicker({ slots, value, onChange, disabled }: { slots: Slot[]; value: number | null; onChange: (i: number) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  // Dates are written in the browser, once it knows the buyer's timezone; the server would show its own clock.
  const [ready, setReady] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setReady(true), []);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const days = useMemo(() => {
    if (!ready) return [] as [string, Slot[]][];
    const by = new Map<string, Slot[]>();
    for (const s of [...slots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) by.set(day(s.at), [...(by.get(day(s.at)) ?? []), s]);
    return [...by.entries()];
  }, [slots, ready]);
  const free = slots.filter((s) => !s.taken).length;
  const chosen = slots.find((s) => s.i === value);

  return (
    <div className={`timepick ${open ? "open" : ""}`} ref={box}>
      <button type="button" className="tp-button" disabled={disabled || free === 0} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{chosen && ready ? `${day(chosen.at)}, ${time(chosen.at)}` : free === 0 ? "Every time is booked" : "Pick a time"}</span>
        <small>
          {free} of {slots.length} free
        </small>
        <i aria-hidden />
      </button>
      {open && (
        <div className="tp-panel" role="listbox" aria-label="Times">
          {days.map(([d, list]) => (
            <div key={d} className="tp-day">
              <b>{d}</b>
              <div>
                {list.map((s) => (
                  <button
                    key={s.i}
                    type="button"
                    role="option"
                    aria-selected={s.i === value}
                    className={s.i === value ? "on" : ""}
                    disabled={s.taken}
                    title={s.taken ? "Already booked" : ""}
                    onClick={() => {
                      onChange(s.i);
                      setOpen(false);
                    }}
                  >
                    {time(s.at)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
