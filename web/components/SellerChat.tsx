"use client";
import { useState } from "react";
import { keccak256, toBytes } from "viem";
import { tifoFactoryAbi } from "@/lib/abi";
import { FACTORY, explorerTx, publicClient } from "@/lib/chain";
import { connect } from "@/lib/wallet";
import type { Proposal } from "@/lib/sellerAgent";

type Msg = { role: "user" | "assistant"; content: string };

export default function SellerChat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [launch, setLaunch] = useState<{ state: "idle" | "working" | "done" | "error"; text?: string; promo?: string; hash?: string }>({ state: "idle" });

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || busy) return;
    const next: Msg[] = [...messages, { role: "user", content: input.trim() }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: next }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setMessages([...next, { role: "assistant", content: j.reply || "…" }]);
      if (j.proposal) setProposal(j.proposal);
    } catch (err) {
      setMessages([...next, { role: "assistant", content: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  async function launchPromo() {
    if (!proposal) return;
    try {
      setLaunch({ state: "working", text: "Connect the wallet that should receive your sales…" });
      const { address, client } = await connect();
      const kickoff = Math.floor(Date.parse(proposal.kickoff) / 1000);
      const meta = JSON.stringify({
        slug: proposal.slug,
        league: proposal.league,
        teamA: proposal.teamA,
        teamB: proposal.teamB,
        kickoff: proposal.kickoff,
        shop: proposal.shop,
        product: proposal.product,
        priceUsd: proposal.priceUsd,
        link: proposal.link,
        image: proposal.image,
        baseRates: proposal.rates,
        minBps: proposal.minBps,
        maxBps: proposal.maxBps,
        effectiveBps: proposal.effectiveBps,
      });
      setLaunch({ state: "working", text: "Confirm in your wallet (costs about a tenth of a cent in USDC)…" });
      const hash = await client.writeContract({
        account: address,
        chain: client.chain,
        address: FACTORY,
        abi: tifoFactoryAbi,
        functionName: "createPromo",
        args: [
          keccak256(toBytes(proposal.slug)),
          BigInt(kickoff),
          BigInt(kickoff + 110 * 60),
          BigInt(Math.round(proposal.capUsd * 1e6)),
          proposal.minBps,
          proposal.maxBps,
          proposal.rates[0],
          proposal.rates[1],
          meta,
        ],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const promo = receipt.logs.find((l) => l.address.toLowerCase() === FACTORY.toLowerCase())?.topics[1];
      const addr = promo ? `0x${promo.slice(26)}` : undefined;
      setLaunch({ state: "done", hash, promo: addr });
    } catch (e) {
      setLaunch({ state: "error", text: (e as Error).message.split("\n")[0] });
    }
  }

  return (
    <div className="chat">
      <div className="log">
        {messages.length === 0 && (
          <p className="hint">
            Tell me what you sell and who your buyers support. For example: &ldquo;I sell hoodies for $25, my buyers are mostly Arsenal and Chelsea fans, I can
            spend up to $60 on a promo this week.&rdquo;
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.content}
          </div>
        ))}
        {busy && <div className="msg assistant pending">Checking fixtures and odds…</div>}
      </div>

      {proposal && (
        <div className="proposal">
          <h3>
            {proposal.teamA} v {proposal.teamB}
          </h3>
          <p className="meta">
            {proposal.league} · kickoff {new Date(proposal.kickoff).toUTCString().slice(0, 22)} UTC
          </p>
          <div className="sides">
            <div>
              <b>{proposal.rates[0] / 100}%</b> back to {proposal.teamA} fans if they win
            </div>
            <div>
              <b>{proposal.rates[1] / 100}%</b> back to {proposal.teamB} fans if they win
            </div>
          </div>
          <p>
            {proposal.shop}: {proposal.product} at ${proposal.priceUsd}. Most you can owe: <b>${proposal.capUsd}</b>. Draw: no rebate.
          </p>
          <p className="fine">{proposal.explanation}</p>
          {launch.state !== "done" && (
            <button className="pay" onClick={launchPromo} disabled={launch.state === "working"}>
              Launch from my wallet
            </button>
          )}
          {launch.text && <p className={`status ${launch.state === "error" ? "err" : ""}`}>{launch.text}</p>}
          {launch.state === "done" && (
            <p className="status ok">
              Live. <a href={`/p/${launch.promo}`}>Open your promo page</a> · <a href={explorerTx(launch.hash!)} target="_blank" rel="noreferrer">transaction</a>
            </p>
          )}
        </div>
      )}

      <form onSubmit={send} className="composer">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Message your sales rep…" disabled={busy} />
        <button disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}
