"use client";
import { useState } from "react";
import { keccak256, parseSignature, toBytes, type Address } from "viem";
import { erc20Abi } from "@/lib/abi";
import { USDC, chain, explorerTx, publicClient } from "@/lib/chain";
import { connect } from "@/lib/wallet";

interface Props {
  promo: Address;
  side: 0 | 1;
  team: string;
  rateBps: number;
  priceUsd: number;
  product: string;
  closed: boolean;
}

type Status = { kind: "idle" } | { kind: "working"; text: string } | { kind: "done"; hash: string } | { kind: "error"; text: string };

export default function Checkout({ promo, side, team, rateBps, priceUsd, product, closed }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const back = ((priceUsd * rateBps) / 10_000).toFixed(2);

  async function pay() {
    try {
      setStatus({ kind: "working", text: "Connecting wallet…" });
      const { address, client } = await connect();
      const amount = BigInt(Math.round(priceUsd * 1e6));
      const bal = (await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] })) as bigint;
      if (bal < amount) throw new Error(`This wallet has $${(Number(bal) / 1e6).toFixed(2)} USDC on Arc. You need $${priceUsd.toFixed(2)}. Withdraw USDC to Arc from your exchange first.`);
      const nonce = (await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "nonces", args: [address] })) as bigint;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
      setStatus({ kind: "working", text: "Sign to pay. No gas needed." });
      const sig = await client.signTypedData({
        account: address,
        domain: { name: "USDC", version: "2", chainId: chain.id, verifyingContract: USDC },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: { owner: address, spender: promo, value: amount, nonce, deadline },
      });
      const { r, s, v, yParity } = parseSignature(sig);
      setStatus({ kind: "working", text: "Paying on Arc…" });
      const orderRef = keccak256(toBytes(`${promo}:${address}:${Date.now()}`));
      const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          promo,
          buyer: address,
          side,
          amount: amount.toString(),
          orderRef,
          deadline: deadline.toString(),
          v: Number(v ?? BigInt(27 + (yParity ?? 0))),
          r,
          s,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Payment failed");
      setStatus({ kind: "done", hash: j.hash });
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message.split("\n")[0] });
    }
  }

  return (
    <div className="checkout">
      <button className="pay" disabled={closed || status.kind === "working"} onClick={pay}>
        {closed ? "Closed at kickoff" : `Buy as a ${team} fan · $${priceUsd.toFixed(2)}`}
      </button>
      <p className="fine">
        {product}. If {team} win, ${back} ({rateBps / 100}%) comes back to your wallet automatically after the final whistle.
      </p>
      {status.kind === "working" && <p className="status">{status.text}</p>}
      {status.kind === "error" && <p className="status err">{status.text}</p>}
      {status.kind === "done" && (
        <p className="status ok">
          Paid. <a href={explorerTx(status.hash)} target="_blank" rel="noreferrer">View on Arc explorer</a>
        </p>
      )}
    </div>
  );
}
