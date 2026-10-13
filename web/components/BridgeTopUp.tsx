"use client";
// "Move USDC from another chain": a buyer who already holds USDC on Base, Ethereum, Arbitrum, Optimism or Polygon
// (for example bought with naira on a local exchange) moves it into their Tifo wallet on Arc in one signature.
// Circle's CCTP burns it on the source chain and Circle's Forwarding Service mints it on Arc, so the buyer needs
// no gas and no wallet on Arc. The checkout is already watching the balance and can buy as soon as it lands.
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NETWORK } from "@/lib/chain";

type Source = { id: string; label: string; sourceFee: boolean };
const SOURCES: Source[] =
  NETWORK === "testnet"
    ? [
        { id: "Base_Sepolia", label: "Base Sepolia", sourceFee: true },
        { id: "Ethereum_Sepolia", label: "Ethereum Sepolia", sourceFee: true },
        { id: "Arbitrum_Sepolia", label: "Arbitrum Sepolia", sourceFee: true },
        { id: "Optimism_Sepolia", label: "Optimism Sepolia", sourceFee: true },
        { id: "Polygon_Amoy_Testnet", label: "Polygon Amoy", sourceFee: false },
      ]
    : [
        { id: "Base", label: "Base", sourceFee: true },
        { id: "Ethereum", label: "Ethereum", sourceFee: true },
        { id: "Arbitrum", label: "Arbitrum", sourceFee: true },
        { id: "Optimism", label: "Optimism", sourceFee: true },
        { id: "Polygon", label: "Polygon", sourceFee: false },
      ];
const ARC = NETWORK === "testnet" ? "Arc_Testnet" : "Arc";

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
const injected = () => (typeof window === "undefined" ? undefined : (window as unknown as { ethereum?: Eip1193 }).ethereum);
const cents = (n: number) => Math.ceil(n * 100) / 100;

type Phase =
  | { k: "pick" }
  | { k: "quoting" }
  | { k: "quote"; send: number; receive: number; fee: number }
  | { k: "moving"; step: string }
  | { k: "done" }
  | { k: "error"; text: string };

/** Links that open the top up page inside a wallet app's own browser, with the Tifo address and amount filled in. */
export function walletLinks(recipient: string, neededUsd: number) {
  const origin = typeof location === "undefined" ? "https://tifo.vercel.app" : location.origin;
  const page = `${origin}/topup?to=${recipient}&amount=${cents(Math.max(neededUsd, 1)).toFixed(2)}`;
  return {
    metamask: `https://metamask.app.link/dapp/${page.replace(/^https?:\/\//, "")}`,
    coinbase: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(page)}`,
    page,
  };
}

export default function BridgeTopUp({ recipient, neededUsd, onClose, inline = false }: { recipient: string; neededUsd: number; onClose: (moved: boolean) => void; inline?: boolean }) {
  const [src, setSrc] = useState<Source>(SOURCES[0]);
  const [phase, setPhase] = useState<Phase>({ k: "pick" });
  const [need] = useState(cents(Math.max(neededUsd, 1)));
  const kit = useRef<import("@circle-fin/bridge-kit").BridgeKit | null>(null);
  const adapter = useRef<unknown>(null);
  const quote = useRef<unknown>(null);
  const hasWallet = !!injected();
  const links = walletLinks(recipient, neededUsd);
  const [copied, setCopied] = useState(false);

  async function setup() {
    const [{ BridgeKit }, { createViemAdapterFromProvider }] = await Promise.all([import("@circle-fin/bridge-kit"), import("@circle-fin/adapter-viem-v2")]);
    if (!kit.current) {
      kit.current = new BridgeKit();
      kit.current.on("*", (e: unknown) => {
        const name = (e as { method?: string; values?: { name?: string } })?.method ?? (e as { values?: { name?: string } })?.values?.name;
        if (name) setPhase((p) => (p.k === "moving" ? { k: "moving", step: stepWords(String(name)) } : p));
      });
    }
    if (!adapter.current) {
      await injected()!.request({ method: "eth_requestAccounts" });
      adapter.current = await createViemAdapterFromProvider({ provider: injected() as never });
    }
    return kit.current;
  }

  const params = (amount: number) =>
    ({
      from: { adapter: adapter.current as never, chain: src.id },
      to: { chain: ARC, recipientAddress: recipient, useForwarder: true },
      amount: amount.toFixed(2),
      config: { transferSpeed: "FAST", ...(src.sourceFee ? { feePayment: "source" } : {}) },
    }) as never;

  async function getQuote() {
    setPhase({ k: "quoting" });
    try {
      const k = await setup();
      const est = (await k.estimate(params(need))) as unknown as Record<string, unknown>;
      if ("amountReceived" in est) {
        // Source-paid: the buyer's wallet pays the fee on top and exactly `need` lands on Arc.
        quote.current = est.quote;
        const debit = Number(est.totalDebit ?? need);
        return setPhase({ k: "quote", send: cents(debit), receive: need, fee: cents(debit - need) });
      }
      // Fee taken from the minted amount: send a little more so what lands still covers the order.
      quote.current = null;
      const fees = (est.fees as { amount: string | null }[] | undefined) ?? [];
      const fee = cents(fees.reduce((t, f) => t + (Number(f.amount) || 0), 0));
      setPhase({ k: "quote", send: cents(need + fee), receive: need, fee });
    } catch (e) {
      setPhase({ k: "error", text: friendly(e) });
    }
  }

  async function move(send: number) {
    setPhase({ k: "moving", step: "Confirm in your wallet" });
    try {
      const k = await setup();
      const base = params(src.sourceFee ? need : send) as Record<string, unknown>;
      const r = (await k.bridge((quote.current ? { ...base, quote: quote.current } : base) as never)) as { state: string; steps?: { name: string; state: string }[] };
      if (r.state === "error") {
        const bad = r.steps?.find((s) => s.state === "error");
        return setPhase({ k: "error", text: `The ${bad?.name?.toLowerCase() ?? "transfer"} step did not go through. Nothing more was taken; try again.` });
      }
      setPhase({ k: "done" });
    } catch (e) {
      setPhase({ k: "error", text: friendly(e) });
    }
  }

  if (typeof document === "undefined") return null;
  const wrap = (card: React.ReactNode) =>
    inline ? (
      <div className="sheet-card" style={{ margin: "0 auto" }}>{card}</div>
    ) : (
      createPortal(
        <div className="sheet" role="dialog" aria-modal="true" aria-label="Move USDC from another chain">
          <div className="sheet-card">{card}</div>
        </div>,
        document.body,
      )
    );
  return wrap(
    <>
        <header>
          <b>{phase.k === "done" ? "On its way" : "Move USDC from another chain"}</b>
          {!inline && (
            <button className="link" onClick={() => onClose(phase.k === "done")}>
              {phase.k === "done" ? "Continue" : "Close"}
            </button>
          )}
        </header>

        {!hasWallet ? (
          <>
            <p className="fine">
              Your USDC is in another wallet app. Open the top up there: your Tifo address and {money(need)} are filled in. Sign once, then come back here and tap Buy.
            </p>
            <a className="btn block" href={links.metamask}>
              Open in MetaMask
            </a>
            <a className="btn block ghost" href={links.coinbase}>
              Open in Coinbase Wallet
            </a>
            <button
              className="link fine"
              onClick={() => {
                navigator.clipboard?.writeText(links.page);
                setCopied(true);
              }}
            >
              {copied ? "Link copied. Paste it in your wallet app's browser" : "Using another wallet? Copy the link"}
            </button>
          </>
        ) : phase.k === "pick" || phase.k === "quoting" || phase.k === "error" ? (
          <>
            <p className="fine">Where is your USDC now? You sign once there. Circle moves it to your Tifo wallet on Arc, usually within a few minutes.</p>
            <div className="chips">
              {SOURCES.map((s) => (
                <button key={s.id} className={src.id === s.id ? "on" : ""} onClick={() => setSrc(s)} disabled={phase.k === "quoting"}>
                  {s.label}
                </button>
              ))}
            </div>
            {phase.k === "error" && <p className="status err">{phase.text}</p>}
            <button className="btn block" onClick={getQuote} disabled={phase.k === "quoting"}>
              {phase.k === "quoting" ? "Checking the fee…" : `Move ${money(need)} from ${src.label}`}
            </button>
          </>
        ) : phase.k === "quote" ? (
          <>
            <div className="sum-lines">
              <div>
                <span>You send on {src.label}</span>
                <b>{money(phase.send)}</b>
              </div>
              <div>
                <span>Circle&apos;s transfer fee</span>
                <b>{money(phase.fee)}</b>
              </div>
              <div>
                <span>Lands in your Tifo wallet</span>
                <b>{money(phase.receive)}</b>
              </div>
            </div>
            <button className="btn block" onClick={() => move(phase.send)}>
              Move it
            </button>
            <button className="link fine" onClick={() => setPhase({ k: "pick" })}>
              Change chain
            </button>
          </>
        ) : phase.k === "moving" ? (
          <>
            <div className="skeleton" style={{ height: 22 }} />
            <p className="fine">{phase.step}. Keep this page open.</p>
          </>
        ) : (
          <p className="status ok">
            Sent. {inline ? "Go back to the drop page in your usual browser: your balance updates when it lands on Arc, then tap Buy." : "Your balance updates when it lands on Arc, then tap Buy."}
          </p>
        )}
        <p className="fine">
          Runs on Circle&apos;s CCTP. Tifo never holds your money on the way. Sending to <code>{recipient.slice(0, 6)}…{recipient.slice(-4)}</code> on Arc.
        </p>
    </>,
  );
}

const money = (n: number) => `$${n.toFixed(2)}`;

function stepWords(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("approve")) return "Approving USDC on the source chain";
  if (n.includes("burn")) return "Sending from the source chain";
  if (n.includes("attest")) return "Waiting for Circle to confirm";
  if (n.includes("mint")) return "Landing in your Tifo wallet on Arc";
  return "Moving your USDC";
}

function friendly(e: unknown): string {
  const m = String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? e);
  if (/reject|denied|cancel/i.test(m)) return "You cancelled in your wallet. Nothing was sent.";
  if (/insufficient|exceeds balance|balance/i.test(m)) return "Not enough USDC (or gas) in that wallet on this chain.";
  if (/chain|network|switch/i.test(m)) return "Your wallet could not switch to that chain. Switch it yourself and try again.";
  if (/503|SERVICE_NOT_ENABLED/i.test(m)) return "Circle has paused transfers from this chain right now. Pick another one.";
  return m.split("\n")[0].slice(0, 180);
}
