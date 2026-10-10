// A seller's TifoAccount: the standing rule they give their sales manager, read from Arc.
import type { Address } from "viem";
import { erc20Abi, tifoAccountAbi, tifoFactoryAbi } from "./abi";
import { FACTORY, USDC, publicClient } from "./chain";
import type { PromoMeta } from "./promos";

const ZERO = "0x0000000000000000000000000000000000000000";

export interface AccountProposal {
  id: number;
  cap: string; // USDC units as strings so the JSON survives
  reason: string;
  at: number;
  status: "waiting" | "approved" | "declined";
  meta: PromoMeta | null;
}

export interface AccountState {
  address: Address;
  weeklyBps: number; // share of the last 7 days of sales the agent may put at risk each week
  baseWeekly: string; // a fixed weekly amount on top
  perDealCap: string; // the most one drop may cost
  allowance: string; // what the rule allows this week
  committed: string; // budgets of drops opened in the last 7 days
  recentSales: string;
  balance: string; // USDC sitting in the account
  proposals: AccountProposal[];
}

export async function accountOf(owner: Address): Promise<Address | null> {
  if (/^0x0+$/.test(FACTORY)) return null;
  const a = await publicClient.readContract({ address: FACTORY, abi: tifoFactoryAbi, functionName: "accountOf", args: [owner] });
  return a === ZERO ? null : a;
}

const STATUS = ["waiting", "approved", "declined"] as const;

export async function accountState(address: Address): Promise<AccountState> {
  const c = { address, abi: tifoAccountAbi } as const;
  const [weeklyBps, baseWeekly, perDealCap, allowance, committed, recentSales, count, balance] = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: "weeklyBps" },
      { ...c, functionName: "baseWeekly" },
      { ...c, functionName: "perDealCap" },
      { ...c, functionName: "allowance" },
      { ...c, functionName: "committed" },
      { ...c, functionName: "recentSales" },
      { ...c, functionName: "proposalsCount" },
      { address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] },
    ],
  });
  const n = Number(count);
  const raw = n ? await publicClient.readContract({ ...c, functionName: "getProposals", args: [BigInt(Math.max(0, n - 20)), 20n] }) : [];
  const first = Math.max(0, n - 20);
  const proposals = raw
    .map((p, i): AccountProposal => {
      let meta: PromoMeta | null = null;
      try {
        meta = JSON.parse(p.meta) as PromoMeta;
      } catch {
        // a proposal whose details don't parse is still listed, with its reason
      }
      return { id: first + i, cap: p.terms.cap.toString(), reason: p.reason, at: Number(p.at), status: STATUS[p.status] ?? "waiting", meta };
    })
    .reverse();
  return {
    address,
    weeklyBps: Number(weeklyBps),
    baseWeekly: baseWeekly.toString(),
    perDealCap: perDealCap.toString(),
    allowance: allowance.toString(),
    committed: committed.toString(),
    recentSales: recentSales.toString(),
    balance: (balance as bigint).toString(),
    proposals,
  };
}
