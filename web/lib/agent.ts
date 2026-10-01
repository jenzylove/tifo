// The agent's on-chain hands. Server-only: the key never reaches the browser.
// Its contract role can only change future offers, log decisions, propose results and push refunds.
import "server-only";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rebalance } from "@tifo/core";
import { tifoPromoAbi } from "./abi";
import { chain, publicClient } from "./chain";
import { matchBySlug } from "./matches";
import { checkResult } from "./results";
import { listPromos, promoState, type PromoSummary } from "./promos";

function wallet() {
  const pk = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("AGENT_PRIVATE_KEY is not set");
  return createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http() });
}

async function send(address: Address, functionName: string, args: readonly unknown[]): Promise<Hex> {
  const w = wallet();
  const { request } = await publicClient.simulateContract({
    account: w.account,
    address,
    abi: tifoPromoAbi,
    functionName: functionName as never,
    args: args as never,
  });
  const hash = await w.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export interface PermitBuy {
  promo: Address;
  buyer: Address;
  side: 0 | 1;
  amount: bigint;
  orderRef: Hex;
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

/** Relay a buyer's signed permit. The buyer pays no gas; funds can only come from the signer. */
export async function relayBuy(b: PermitBuy): Promise<Hex> {
  return send(b.promo, "buyWithPermit", [b.buyer, b.side, b.amount, b.orderRef, b.deadline, b.v, b.r, b.s]);
}

/**
 * After every sale: if one side's refund bill has run ahead, move the offers.
 * The math (core.rebalance) is deterministic; the agent only acts when the change is material
 * and records why on chain.
 */
export async function maybeRebalance(p: PromoSummary): Promise<{ changed: boolean; hash?: Hex; reason: string }> {
  const st = await promoState(p.address);
  if (Date.now() / 1000 >= st.closesAt) return { changed: false, reason: "closed" };
  const base: [bigint, bigint] = [BigInt(p.meta.baseRates[0]), BigInt(p.meta.baseRates[1])];
  const [na, nb] = rebalance(st.liability, base, p.meta.minBps, p.meta.maxBps).map(Number) as [number, number];
  const moved = Math.abs(na - st.rates[0]) + Math.abs(nb - st.rates[1]);
  if (moved < 100) return { changed: false, reason: "within 1 point of current offers" };
  const [la, lb] = st.liability.map((x) => Number(x) / 1e6);
  const heavy = la > lb ? p.meta.teamA : p.meta.teamB;
  const light = la > lb ? p.meta.teamB : p.meta.teamA;
  const reason = `${heavy} side owes $${Math.max(la, lb).toFixed(2)} if they win vs $${Math.min(la, lb).toFixed(2)} for ${light}. Raising the ${light} offer and trimming ${heavy} to pull the book back toward balance.`;
  const hash = await send(p.address, "setRates", [na, nb, reason]);
  return { changed: true, hash, reason };
}

export interface TickResult {
  promo: Address;
  action: string;
  hash?: Hex;
}

/** One pass over every promo: settle what's ready, finalize what's past the window, push refunds. */
export async function tick(): Promise<TickResult[]> {
  const out: TickResult[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const p of await listPromos()) {
    try {
      const st = await promoState(p.address);
      if (st.finalOutcome !== "None") {
        const winners = st.finalOutcome === "A" || st.finalOutcome === "B";
        if (winners && st.refundCursor < st.ordersCount) {
          out.push({ promo: p.address, action: "pay refunds", hash: await send(p.address, "payRefunds", [200n]) });
        } else if (!st.remainderReleased) {
          out.push({ promo: p.address, action: "release remainder", hash: await send(p.address, "releaseRemainder", []) });
        }
        continue;
      }
      if (st.proposed !== "None") {
        if (now >= st.proposedAt + 15 * 60) out.push({ promo: p.address, action: "finalize", hash: await send(p.address, "finalize", []) });
        continue;
      }
      if (now < st.closesAt) continue;
      const m = await matchBySlug(p.meta.slug);
      if (!m) {
        out.push({ promo: p.address, action: "match not found; waiting" });
        continue;
      }
      const c = await checkResult(m);
      if (c.verdict === "VOID" || (c.verdict && now >= st.settleNotBefore)) {
        const code = { A: 1, B: 2, DRAW: 3, VOID: 4 }[c.verdict];
        await send(p.address, "note", ["result", `${c.reason}. Sources: ${c.sources.map((s) => `${s.source}=${s.verdict ?? s.status}`).join(", ")}`]);
        out.push({ promo: p.address, action: `propose ${c.verdict}`, hash: await send(p.address, "proposeResult", [code, c.evidence]) });
      } else if (now > st.settleNotBefore + 6 * 3600 && /disagree/.test(c.reason)) {
        out.push({ promo: p.address, action: `escalate: ${c.reason}` });
      } else {
        out.push({ promo: p.address, action: `wait: ${c.reason}` });
      }
    } catch (e) {
      out.push({ promo: p.address, action: `error: ${(e as Error).message.slice(0, 200)}` });
    }
  }
  return out;
}
