// The agent's record across every seller, in the terms a business owner would ask about: how many businesses it
// runs, what came in, what it paid out, whether it paid on time by itself, and how often it had to ask first.
import "server-only";
import type { Address } from "viem";
import { tifoAccountAbi } from "./abi";
import { publicClient } from "./chain";
import type { PromoState, PromoSummary } from "./promos";
import { accountState } from "./tifoAccount";

export interface AgentRecord {
  businesses: number; // sellers whose money the agent runs through an account with a rule
  received: bigint; // paid in by buyers
  paidBack: bigint; // returned to buyers whose team won
  sentToSellers: bigint; // sent on to sellers' payout wallets by the agent
  settled: number; // drops settled and paid with nobody clicking
  due: number; // drops whose match has ended
  alone: number; // drops opened inside a rule, results settled, payouts sent
  asked: number; // times it went over a rule and asked first
  agreed: number; // of those, how many the seller approved
}

export async function agentRecord(rows: { p: PromoSummary; st: PromoState; volume: bigint }[]): Promise<AgentRecord> {
  const now = Date.now() / 1000;
  const sellers = [...new Set(rows.map((r) => r.p.seller.toLowerCase() as Address))];
  // A seller that is an account answers payout(); a plain wallet, or an account from before payouts, does not.
  const probe = sellers.length ? await publicClient.multicall({ contracts: sellers.map((s) => ({ address: s, abi: tifoAccountAbi, functionName: "payout" }) as const) }) : [];
  const accounts = (await Promise.all(sellers.filter((_, i) => probe[i]?.status === "success").map((a) => accountState(a).catch(() => null)))).filter((a) => a !== null);
  const settled = rows.filter((r) => r.st.finalOutcome !== "None").length;
  return {
    businesses: accounts.length,
    received: rows.reduce((t, r) => t + r.volume, 0n),
    paidBack: rows.reduce((t, r) => t + r.st.refundedTotal, 0n),
    sentToSellers: accounts.reduce((t, a) => t + BigInt(a.paidOut), 0n),
    settled,
    due: rows.filter((r) => now >= r.st.settleNotBefore).length,
    alone: settled + accounts.reduce((t, a) => t + a.deals.filter((d) => d.byAgent).length + a.payouts.length, 0),
    asked: accounts.reduce((t, a) => t + a.proposals.length, 0),
    agreed: accounts.reduce((t, a) => t + a.proposals.filter((p) => p.status === "approved").length, 0),
  };
}
