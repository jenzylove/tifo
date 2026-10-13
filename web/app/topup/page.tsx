"use client";
// Opened inside a wallet app's browser (MetaMask, Coinbase Wallet): moves USDC from another chain to a Tifo wallet
// on Arc. Only the address is needed here, so the buyer's passkey wallet stays in their usual browser.
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import BridgeTopUp from "@/components/BridgeTopUp";

function TopUp() {
  const q = useSearchParams();
  const to = q.get("to") ?? "";
  const amount = Number(q.get("amount") ?? "0");
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || !(amount > 0) || amount > 10_000)
    return <p className="empty panel">This top up link is incomplete. Go back to the drop page and open it again.</p>;
  return <BridgeTopUp recipient={to} neededUsd={amount} inline onClose={() => {}} />;
}

export default function TopUpPage() {
  return (
    <div className="wrap" style={{ maxWidth: 520 }}>
      <div className="pagehead">
        <span className="eyebrow">Tifo top up</span>
        <h1>Move USDC to your Tifo wallet</h1>
        <p>From Base, Ethereum, Arbitrum, Optimism or Polygon to Arc, in one signature.</p>
      </div>
      <Suspense fallback={<div className="skeleton" style={{ height: 22 }} />}>
        <TopUp />
      </Suspense>
    </div>
  );
}
