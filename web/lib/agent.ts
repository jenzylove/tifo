// The agent's on-chain hands. Server-only: the key never reaches the browser.
// Its contract role can only change future offers, log decisions, propose results and push refunds.
import "server-only";
import { createWalletClient, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rebalance } from "@tifo/core";
import { tifoAccountAbi, tifoPromoAbi } from "./abi";
import { planFor, type Plan } from "./autopilot";
import { accountOf } from "./tifoAccount";
import { FACTORY, chain, publicClient, transport } from "./chain";
import { matchBySlug } from "./matches";
import { checkResult } from "./results";
import { listPromos, promoState, type PromoSummary } from "./promos";

function wallet() {
  const pk = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("AGENT_PRIVATE_KEY is not set");
  return createWalletClient({ account: privateKeyToAccount(pk), chain, transport });
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
  minRateBps: number; // the offer the buyer was shown; the sale is refused if it is gone
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

/** Relay a buyer's signed permit. The buyer pays no gas; funds can only come from the signer. */
export async function relayBuy(b: PermitBuy): Promise<Hex> {
  return send(b.promo, "buyWithPermit", [b.buyer, b.side, b.amount, b.orderRef, b.minRateBps, b.deadline, b.v, b.r, b.s]);
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

/** The next settlement step for one promo, if one is due: propose the result, finalize, pay, release. */
async function step(p: PromoSummary, now: number): Promise<TickResult | null> {
  const st = await promoState(p.address);
  if (st.finalOutcome !== "None") {
    // A win pays the winning side; a draw pays every buyer the thank you. Only a voided match pays nobody.
    const owed = st.finalOutcome !== "Void";
    if (owed && st.refundCursor < st.ordersCount) return { promo: p.address, action: "pay refunds", hash: await send(p.address, "payRefunds", [200n]) };
    if (!st.remainderReleased) return { promo: p.address, action: "release remainder", hash: await send(p.address, "releaseRemainder", []) };
    return null;
  }
  if (st.proposed !== "None") {
    if (now >= st.proposedAt + 15 * 60) return { promo: p.address, action: "finalize", hash: await send(p.address, "finalize", []) };
    return null;
  }
  if (now < st.closesAt) return null;
  const m = await matchBySlug(p.meta.slug);
  if (!m) return { promo: p.address, action: "match not found; waiting" };
  const c = await checkResult(m);
  if (c.verdict === "VOID" || (c.verdict && now >= st.settleNotBefore)) {
    const code = { A: 1, B: 2, DRAW: 3, VOID: 4 }[c.verdict];
    await send(p.address, "note", ["result", `${c.reason}. Sources: ${c.sources.map((s) => `${s.source}=${s.verdict ?? s.status}`).join(", ")}`]);
    return { promo: p.address, action: `propose ${c.verdict}`, hash: await send(p.address, "proposeResult", [code, c.evidence]) };
  }
  if (now > st.settleNotBefore + 6 * 3600 && /disagree/.test(c.reason)) return { promo: p.address, action: `escalate: ${c.reason}` };
  return { promo: p.address, action: `wait: ${c.reason}` };
}

/** One pass over every promo: settle what's ready, finalize what's past the window, push refunds. */
export async function tick(): Promise<TickResult[]> {
  const out: TickResult[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const p of await listPromos()) {
    try {
      const r = await step(p, now);
      if (r) out.push(r);
    } catch (e) {
      out.push({ promo: p.address, action: `error: ${(e as Error).message.slice(0, 200)}` });
    }
  }
  return out;
}

const lastNudge = new Map<string, number>();

/**
 * Settle one promo as far as it can go right now. The drop page calls this after it responds, so refunds
 * land while fans are watching instead of waiting for the scheduler. Each step is safe to repeat: the
 * contract refuses a second proposal, a second finalize and a second payout.
 */
export async function settleNow(p: PromoSummary): Promise<TickResult[]> {
  const key = p.address.toLowerCase();
  if (Date.now() - (lastNudge.get(key) ?? 0) < 20_000) return [];
  lastNudge.set(key, Date.now());
  const out: TickResult[] = [];
  try {
    for (let i = 0; i < 4; i++) {
      const r = await step(p, Math.floor(Date.now() / 1000));
      if (!r) break;
      out.push(r);
      if (!r.hash) break; // waiting on a result or the correction window
    }
  } catch (e) {
    out.push({ promo: p.address, action: `error: ${(e as Error).message.slice(0, 200)}` });
  }
  return out;
}

/**
 * On each scheduler run, the agent decides for every seller with an account whether to run a drop. Inside the
 * seller's rule it opens the drop itself; outside it, the contract refuses and the agent can only leave a
 * proposal. A seller with a drop running or a proposal waiting is skipped before the model is asked.
 */
export async function autopilotTick(force?: Address): Promise<TickResult[]> {
  const out: TickResult[] = [];
  const sellers = [...new Set((await listPromos()).map((p) => p.seller.toLowerCase() as Address))];
  // Find every seller who has an account. A drop's seller is the account itself when it was opened through the
  // account, and the seller's own wallet when they opened it by hand before turning autopilot on.
  const owners = new Set<Address>();
  for (const seller of sellers) {
    try {
      const owner = (await publicClient.readContract({ address: seller, abi: tifoAccountAbi, functionName: "owner" }).catch(() => null)) as Address | null;
      if (owner && (await accountOf(owner))?.toLowerCase() === seller) owners.add(owner.toLowerCase() as Address);
      else if (await accountOf(seller)) owners.add(seller);
    } catch (e) {
      out.push({ promo: seller, action: `autopilot error: ${(e as Error).message.slice(0, 200)}` });
    }
  }
  for (const owner of owners) {
    if (force && force.toLowerCase() !== owner) continue;
    try {
      out.push(await act(await planFor(owner, true)));
    } catch (e) {
      out.push({ promo: owner, action: `autopilot error: ${(e as Error).message.slice(0, 200)}` });
    }
  }
  return out;
}

async function act(plan: Plan): Promise<TickResult> {
  if (plan.act === "skip" || !plan.account || !plan.terms || !plan.meta) return { promo: (plan.account ?? FACTORY) as Address, action: `autopilot skip: ${plan.reason}` };
  const w = wallet();
  const call = async (functionName: "openDeal" | "propose") => {
    const { request } = await publicClient.simulateContract({ account: w.account, address: plan.account!, abi: tifoAccountAbi, functionName, args: [plan.terms!, plan.meta!, plan.reason] });
    const hash = await w.writeContract(request);
    return publicClient.waitForTransactionReceipt({ hash });
  };
  if (plan.act === "open") {
    try {
      const receipt = await call("openDeal");
      const log = receipt.logs.find((l) => l.address.toLowerCase() === FACTORY.toLowerCase());
      const promo = (log?.topics[1] ? `0x${log.topics[1].slice(26)}` : plan.account) as Address;
      if (log?.topics[1]) await send(promo, "note", ["opened", plan.reason]);
      return { promo, action: `autopilot opened ${plan.match} for $${plan.capUsd}`, hash: receipt.transactionHash };
    } catch (e) {
      // The rule can change between the plan and the send. The contract is the judge: fall back to a proposal.
      if (!/OverLimit/.test(String(e))) throw e;
    }
  }
  const receipt = await call("propose");
  return { promo: plan.account, action: `autopilot proposed ${plan.match} for $${plan.capUsd}`, hash: receipt.transactionHash };
}
