"use client";
// The seller's books: every dollar in and out, and every decision the agent took, each with its reason and the
// contract where it can be checked. Read from Arc; nothing here is typed in.
import { useState } from "react";
import type { BookLine, Books as BooksData } from "@/lib/manager";

const $ = (units: string | bigint | number) => `$${(Math.abs(Number(units)) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (at: number) => new Date(at * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const LABEL: Record<BookLine["kind"], string> = { in: "In", back: "Paid back", out: "Sent to you", decision: "Decided", asked: "Asked you" };

export default function Books({ books, heading = "Books" }: { books: BooksData; heading?: string }) {
  const [all, setAll] = useState(false);
  const lines = all ? books.lines : books.lines.slice(0, 14);
  return (
    <>
      <div className="mgr-head">
        <div>
          <h1>{heading}</h1>
          <p className="muted">Every dollar in and out, with your agent&apos;s reason. Read from Arc, so nobody can edit it, including us.</p>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi">
          <span>Money in</span>
          <b>{$(books.moneyIn)}</b>
        </div>
        <div className="kpi">
          <span>Money back to fans</span>
          <b>{$(books.paidBack)}</b>
        </div>
        <div className="kpi">
          <span>Sent to you</span>
          <b>{$(books.sentToSeller)}</b>
        </div>
        <div className="kpi">
          <span>Held for open drops</span>
          <b>{$(books.held)}</b>
        </div>
      </div>

      <p className="books-note">
        Your agent did <b>{books.alone}</b> {books.alone === 1 ? "thing" : "things"} by itself
        {books.asked > 0 ? (
          <>
            {" "}
            and asked you first <b>{books.asked}</b> {books.asked === 1 ? "time" : "times"}. You said yes to <b>{books.agreed}</b>.
          </>
        ) : (
          " and has not needed to ask you anything yet."
        )}
        {books.pairs > 0 && (
          <>
            {" "}
            Your buyers brought <b>{books.pairs}</b> more {books.pairs === 1 ? "buyer" : "buyers"} with the challenge link.
          </>
        )}
        {books.due > 0 && (
          <>
            {" "}
            Results settled with nobody clicking: <b>{books.settled}</b> of <b>{books.due}</b>.
          </>
        )}
      </p>

      {books.lines.length === 0 ? (
        <p className="empty">Your first sale shows up here the moment it lands.</p>
      ) : (
        <ol className="ledger">
          {lines.map((l, i) => (
            <li key={i} className={l.kind}>
              <time>{when(l.at)}</time>
              <div>
                <b>{l.title}</b>
                {l.why && <p>{l.why}</p>}
                <a href={l.link} target="_blank" rel="noreferrer">
                  {LABEL[l.kind]} · check it on Arc
                </a>
              </div>
              <span className="amt">{l.amount === null ? "" : `${BigInt(l.amount) < 0n ? "−" : "+"}${$(l.amount)}`}</span>
            </li>
          ))}
        </ol>
      )}
      {books.lines.length > 14 && !all && (
        <button className="link" onClick={() => setAll(true)}>
          Show all {books.lines.length} lines
        </button>
      )}
    </>
  );
}
