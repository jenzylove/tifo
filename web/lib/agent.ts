// The agent's on-chain hands. Server-only: the key never reaches the browser.
// Its contract role can only change future offers, log decisions, propose results and push refunds.
import "server-only";
import { createWalletClient, erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rebalance } from "@tifo/core";
import { tifoAccountAbi, tifoPromoAbi } from "./abi";
import { planFor, type Plan } from "./autopilot";
import { accountOf, dropOwner } from "./tifoAccount";
import { FACTORY, USDC, chain, publicClient, transport, usd } from "./chain";
import { matchBySlug, shortTeam } from "./matches";
import { checkResult } from "./results";
import { listPromos, promoJournal, promoOrders, promoState, type PromoSummary } from "./promos";
import { dueAction, readDeliveries } from "./shipments";

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

/**
 * After every sale: if one side's refund bill has run ahead, move the offers.
 * The math (core.rebalance) is deterministic; the agent only acts when the change is material
 * and records why on chain.
 */
export async function maybeRebalance(p: PromoSummary): Promise<{ changed: boolean; hash?: Hex; reason: string }> {
  const st = await promoState(p.address);
  if (Date.now() / 1000 >= st.closesAt) return { changed: false, reason: "closed" };
  const base: [bigint, bigint] = [BigInt(p.meta.baseRates[0]), BigInt(p.meta.baseRates[1])];
  const [na, nb] = rebalance(st.liability, base, p.meta.minBps, p.meta.maxBps, 0.5, st.cap).map(Number) as [number, number];
  const moved = Math.abs(na - st.rates[0]) + Math.abs(nb - st.rates[1]);
  if (moved < 100) return { changed: false, reason: "within 1 point of current offers" };
  const [la, lb] = st.liability.map((x) => Number(x) / 1e6);
  const heavy = shortTeam(la > lb ? p.meta.teamA : p.meta.teamB);
  const light = shortTeam(la > lb ? p.meta.teamB : p.meta.teamA);
  const pct = (b: number) => (b >= 10_000 ? "free" : `${b / 100}% back`);
  const [ha, hb] = la > lb ? [na, nb] : [nb, na];
  const reason = `More ${heavy} fans have bought ($${Math.max(la, lb).toFixed(2)} would go back if ${heavy} win, $${Math.min(la, lb).toFixed(2)} if ${light} win). New ${heavy} buyers now get ${pct(ha)} and ${light} buyers ${pct(hb)}, so the shop's cost stays about the same whoever wins.`;
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
    if (owed && st.refundCursor < st.ordersCount) {
      // Too few buyers for the offer to switch on: say so in the drop's own log before closing the books on it.
      if (st.buyers < st.minBuyers)
        await send(p.address, "note", ["offer off", `${st.buyers} of the ${st.minBuyers} buyers needed bought, so the offer stayed off. Every sale goes to the seller.`]).catch(() => {});
      return { promo: p.address, action: "pay refunds", hash: await send(p.address, "payRefunds", [200n]) };
    }
    // Referrals are settled before the remainder: free orders first, then whatever was set aside for unfinished ones.
    if (st.refNeeded > 0 && !st.remainderReleased) {
      const [cursor, total] = await publicClient.multicall({
        allowFailure: false,
        contracts: [
          { address: p.address, abi: tifoPromoAbi, functionName: "refCursor" },
          { address: p.address, abi: tifoPromoAbi, functionName: "referrersCount" },
        ],
      });
      if (cursor < total) return { promo: p.address, action: "settle referrals", hash: await send(p.address, "settleReferrals", [100n]) };
    }
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

// Anyone can open drops on the factory, so the agent's gas has to go where buyers' money is first, and some must stay
// for them. Each pass sends at most MAX_WRITES transactions, drops holding the most money go first, and once the
// agent's gas runs low it only works on drops that hold money.
const MAX_WRITES = 30;
const LOW_GAS = 500_000_000_000_000_000n; // 0.5 USDC (Arc's native USDC has 18 decimals)
export const MIN_DELIVERY_ACT = 500_000n; // $0.50: smaller held amounts are left for the buyer or seller to settle

/** One pass over every promo: settle what's ready, finalize what's past the window, push refunds, settle deliveries. */
export async function tick(): Promise<TickResult[]> {
  const out: TickResult[] = [];
  const now = Math.floor(Date.now() / 1000);
  const promos = await listPromos();
  const states = await Promise.all(promos.map((p) => promoState(p.address).catch(() => null)));
  const stake = (i: number) => states[i]?.reserve ?? 0n;
  const order = promos.map((_, i) => i).sort((a, b) => (stake(b) > stake(a) ? 1 : stake(b) < stake(a) ? -1 : 0));
  const gas = await Promise.resolve()
    .then(() => publicClient.getBalance({ address: wallet().account.address }))
    .catch(() => LOW_GAS);
  const lowGas = gas < LOW_GAS;
  if (lowGas) out.push({ promo: FACTORY, action: `agent gas low (${Number(gas / 10n ** 12n) / 1e6} USDC): only drops holding money are worked on` });
  let writes = 0;
  for (const i of order) {
    const p = promos[i];
    if (writes >= MAX_WRITES) {
      out.push({ promo: p.address, action: "deferred: this pass's transactions are used up" });
      continue;
    }
    try {
      // With little gas left, a drop that holds no refund money waits; nobody is owed anything by its result.
      const r = lowGas && stake(i) === 0n ? null : await step(p, now);
      if (r) out.push(r);
      if (r?.hash) writes++;
    } catch (e) {
      out.push({ promo: p.address, action: `error: ${(e as Error).message.slice(0, 200)}` });
    }
    try {
      const d = await deliveriesTick(p, now, MAX_WRITES - writes);
      writes += d.filter((x) => x.hash).length;
      out.push(...d);
    } catch (e) {
      out.push({ promo: p.address, action: `delivery error: ${(e as Error).message.slice(0, 200)}` });
    }
  }
  out.push(...(await payoutsTick().catch((e) => [{ promo: FACTORY, action: `payout error: ${(e as Error).message.slice(0, 200)}` }])));
  return out;
}

/**
 * A buyer came through a friend's link. When that friend reaches the number of referrals the seller set, the agent says
 * so in the drop's journal, once: their order will be free after the match. The contract already counted it; the note
 * is the record a person can read.
 */
export async function noteReferral(p: PromoSummary, referrer: Address): Promise<TickResult | null> {
  const c = { address: p.address, abi: tifoPromoAbi } as const;
  const [need, count] = await publicClient.multicall({ allowFailure: false, contracts: [{ ...c, functionName: "refNeeded" }, { ...c, functionName: "refCount", args: [referrer] }] });
  if (!Number(need) || Number(count) < Number(need)) return null;
  const st = await promoState(p.address);
  const journal = await promoJournal(p.address, st.journalCount);
  const who = referrer.toLowerCase();
  if (journal.some((j) => j.kind === "referral" && j.text.toLowerCase().includes(who))) return null;
  const text = `${who} brought ${Number(need)} new buyers, so their order is free: what they paid comes back after the match, whoever wins.`;
  return { promo: p.address, action: `referral: ${text}`, hash: await send(p.address, "note", ["referral", text]) };
}

const MIN_PAYOUT = 100_000n; // $0.10: below this the transfer is not worth a transaction

/**
 * A seller's money does not wait for a person. Whatever an account holds is sent to the payout wallet its owner
 * chose; the contract allows no other destination. Refund money never passes through the account: each drop keeps
 * its own until full time, so everything in the account is the seller's.
 */
export async function payoutsTick(only?: Address): Promise<TickResult[]> {
  const promos = await listPromos();
  const sellers = [...new Set(promos.map((p) => p.seller.toLowerCase() as Address))].filter((s) => !only || s === only.toLowerCase());
  if (!sellers.length) return [];
  const reads = await publicClient.multicall({
    contracts: sellers.flatMap((s) => [
      { address: s, abi: tifoAccountAbi, functionName: "payout" } as const,
      { address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [s] } as const,
    ]),
  });
  const out: TickResult[] = [];
  for (let i = 0; i < sellers.length; i++) {
    const payout = reads[2 * i], balance = reads[2 * i + 1];
    // A seller that is a plain wallet, or an account from before payouts existed, has no payout() to read.
    if (payout.status !== "success" || balance.status !== "success" || (balance.result as bigint) < MIN_PAYOUT) continue;
    const account = sellers[i];
    try {
      const mine = promos.filter((p) => p.seller.toLowerCase() === account);
      const states = await Promise.all(mine.map((p) => promoState(p.address)));
      const open = mine.filter((_, k) => states[k].finalOutcome === "None");
      const locked = states.reduce((t, st) => t + (st.finalOutcome === "None" ? st.reserve : 0n), 0n);
      const from = mine[0] ? `${shortTeam(mine[0].meta.teamA)} v ${shortTeam(mine[0].meta.teamB)}` : "your drops";
      const reason =
        open.length && locked > 0n
          ? `${usd(balance.result as bigint)} from ${mine.length === 1 ? `your ${from} drop` : "your drops"}. The ${usd(locked)} that could be owed back to buyers stays locked inside ${open.length === 1 ? "the open drop" : "the open drops"}, so all of this is yours.`
          : `${usd(balance.result as bigint)} from ${mine.length === 1 ? `your ${from} drop` : "your drops"}. Nothing more is owed to any buyer, so all of this is yours.`;
      const w = wallet();
      const { request } = await publicClient.simulateContract({ account: w.account, address: account, abi: tifoAccountAbi, functionName: "payOut", args: [reason] });
      const hash = await w.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash });
      out.push({ promo: account, action: `paid out ${usd(balance.result as bigint)} to ${(payout.result as Address).slice(0, 8)}…`, hash });
    } catch (e) {
      out.push({ promo: account, action: `payout error: ${(e as Error).message.slice(0, 200)}` });
    }
  }
  return out;
}

/**
 * Physical orders: pay the seller once the window after "sent" passes with no dispute, and return the money to
 * buyers whose order was never marked sent. Both are open to anyone on the contract; the agent just keeps them moving.
 * Disputes are left alone: only the operator settles those.
 */
export async function deliveriesTick(p: PromoSummary, now: number, budget = MAX_WRITES): Promise<TickResult[]> {
  if (!p.meta.contact && p.meta.delivery) return []; // digital
  const st = await promoState(p.address);
  if (!st.ordersCount) return [];
  const d = await readDeliveries(p.address, st.ordersCount);
  if (!d) return [];
  const orders = await promoOrders(p.address, st.ordersCount);
  const out: TickResult[] = [];
  for (let i = 0; i < d.list.length && out.length < budget; i++) {
    const act = dueAction(d.list[i], orders[i].at, d.holdSecs, now);
    if (!act || orders[i].amount < MIN_DELIVERY_ACT) continue;
    const hash = await send(p.address, act, [BigInt(i)]);
    out.push({ promo: p.address, action: act === "release" ? `delivery ${i}: paid the seller` : `delivery ${i}: never sent, returned to buyer`, hash });
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
  // What came back to the seller's account at full time goes on to their wallet in the same pass.
  if (out.some((r) => r.action === "release remainder")) out.push(...(await payoutsTick(p.seller).catch(() => [])));
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
      // The person behind the drop: the account's owner, whichever factory the account is on, or the wallet itself.
      // Autopilot runs for them once they have an account on the current factory.
      const owner = (await dropOwner(seller)).toLowerCase() as Address;
      if (await accountOf(owner)) owners.add(owner);
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
