// A seller's TifoAccount: the standing rule they give their sales manager, read from Arc.
import type { Address } from "viem";
import { erc20Abi, tifoAccountAbi, tifoFactoryAbi } from "./abi";
import { FACTORY, USDC, publicClient, OLD_FACTORIES } from "./chain";
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

/** A drop opened through the account: by the agent alone, or by the seller (directly or by approving a proposal). */
export interface AccountDeal {
  promo: Address;
  at: number;
  cap: string;
  byAgent: boolean;
  reason: string;
}

/** One transfer of the account's balance to the seller's payout wallet. */
export interface AccountPayout {
  at: number;
  to: Address;
  amount: string;
  reason: string;
}

export interface AccountState {
  address: Address;
  weeklyBps: number; // share of the last 7 days of sales the agent may put at risk each week
  baseWeekly: string; // a fixed weekly amount on top
  perDealCap: string; // the most one drop may cost
  allowance: string; // what the rule allows this week
  committed: string; // budgets of drops opened in the last 7 days
  recentSales: string;
  balance: string; // USDC sitting in the account, on its way to the payout wallet
  payout: Address; // where the account's money is sent; only the owner can change it
  paidOut: string; // everything sent there so far
  deals: AccountDeal[]; // newest first
  payouts: AccountPayout[]; // newest first
  proposals: AccountProposal[];
  current?: boolean; // false for an account on an earlier factory: its history shows, new drops need a current account
}

export async function accountOf(owner: Address): Promise<Address | null> {
  if (/^0x0+$/.test(FACTORY)) return null;
  const a = await publicClient.readContract({ address: FACTORY, abi: tifoFactoryAbi, functionName: "accountOf", args: [owner] });
  return a === ZERO ? null : a;
}

/** Accounts this seller opened on earlier factories. Their drops and payouts stay in the seller's books; new drops
 * open through an account on the current factory. */
export async function olderAccountsOf(owner: Address): Promise<Address[]> {
  if (!OLD_FACTORIES.length) return [];
  const r = await publicClient.multicall({
    allowFailure: true,
    contracts: OLD_FACTORIES.map((f) => ({ address: f, abi: tifoFactoryAbi, functionName: "accountOf", args: [owner] }) as const),
  });
  return r.flatMap((x) => (x.status === "success" && x.result !== ZERO ? [x.result as Address] : []));
}

/**
 * The person behind a drop's seller address: the owner of the Tifo account when the drop was opened through one,
 * otherwise the seller wallet itself. An account counts only if one of our factories made it for that owner, so a
 * contract that merely claims an owner() is not believed.
 */
export async function dropOwner(seller: Address): Promise<Address> {
  const owner = (await publicClient.readContract({ address: seller, abi: tifoAccountAbi, functionName: "owner" }).catch(() => null)) as Address | null;
  if (!owner) return seller;
  const factories = [FACTORY, ...OLD_FACTORIES].filter((f) => !/^0x0+$/.test(f));
  const r = await publicClient.multicall({
    allowFailure: true,
    contracts: factories.map((f) => ({ address: f, abi: tifoFactoryAbi, functionName: "accountOf", args: [owner] }) as const),
  });
  return r.some((x) => x.status === "success" && String(x.result).toLowerCase() === seller.toLowerCase()) ? owner : seller;
}

const STATUS = ["waiting", "approved", "declined"] as const;

export async function accountState(address: Address): Promise<AccountState> {
  const c = { address, abi: tifoAccountAbi } as const;
  const [weeklyBps, baseWeekly, perDealCap, allowance, committed, recentSales, count, balance, payout, paidOut, dealsCount, payoutsCount] = await publicClient.multicall({
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
      { ...c, functionName: "payout" },
      { ...c, functionName: "paidOutTotal" },
      { ...c, functionName: "dealsCount" },
      { ...c, functionName: "payoutsCount" },
    ],
  });
  const last = (total: bigint, n: number) => [BigInt(Math.max(0, Number(total) - n)), BigInt(n)] as const;
  const [deals, payouts] = await Promise.all([
    Number(dealsCount) ? publicClient.readContract({ ...c, functionName: "getDeals", args: last(dealsCount, 60) }) : [],
    Number(payoutsCount) ? publicClient.readContract({ ...c, functionName: "getPayouts", args: last(payoutsCount, 100) }) : [],
  ]);
  const n = Number(count);
  const raw = n ? await publicClient.readContract({ ...c, functionName: "getProposals", args: [BigInt(Math.max(0, n - 20)), 20n] }).catch(() => []) : [];
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
    payout,
    paidOut: paidOut.toString(),
    deals: deals.map((d): AccountDeal => ({ promo: d.promo, at: Number(d.createdAt), cap: d.cap.toString(), byAgent: d.byAgent, reason: d.reason })).reverse(),
    payouts: payouts.map((p): AccountPayout => ({ at: Number(p.at), to: p.to, amount: p.amount.toString(), reason: p.reason })).reverse(),
    proposals,
  };
}
