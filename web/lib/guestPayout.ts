// Money back to a bank, for guest buyers. Server only.
// A guest's money back (a refund the drop paid or kept for them, or a failed order's money) sits at their Tifo number's
// address. To collect it in naira: the buyer picks a bank and types an account number, Bachs resolves the account name,
// the buyer confirms it, then the server (1) claims any refund the drop kept, (2) moves the USDC from the buyer's address
// to the naira float (that USDC backs the naira paid out), and (3) asks Bachs to pay the naira to the bank.
// Exactly once per checkout: every step is written down before the next, the amount is fixed before the USDC moves, and
// each payout carries a reference Bachs refuses to reuse, looked up before any new payout is sent.
import "server-only";
import { createHash } from "node:crypto";
import { createWalletClient, erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tifoPromoAbi } from "./abi";
import { USDC, chain, publicClient, transport } from "./chain";
import { blobStore, diagEvent, guestKey, guestSecret, openPhone, parseGuestReference, type GuestRecord, type GuestStore, type PayoutInfo } from "./guest";
import { bachsCall, fetchSession, isCheckoutId, nairaConfig, usdcBalance, type BachsSession, type NairaConfig } from "./naira";

const MIN_UNITS = 200_000n; // $0.20: less than this is not worth a bank transfer

/** Collecting to a bank is on only when NAIRA_PAYOUTS is "1" and naira payments are set up. */
export const payoutsOn = (env: Record<string, string | undefined> = process.env) => (env.NAIRA_PAYOUTS ?? "").trim() === "1" && nairaConfig(env) !== null;

/** USDC units to whole naira at the naira rate, rounded down. */
export function nairaFor(units: bigint, rate: number): bigint {
  const koboPerUsd = BigInt(Math.round(rate * 100));
  return (units * koboPerUsd) / 1_000_000n / 100n;
}

export const payoutReference = (checkoutId: string, attempt = 0) => `tifo-gp-${checkoutId}${attempt > 0 ? `-${attempt}` : ""}`;
const REF = /^tifo-gp-(chk_[A-Za-z0-9]+)(?:-(\d{1,3}))?$/;
export function parsePayoutReference(ref: unknown): { checkoutId: string; attempt: number } | null {
  if (typeof ref !== "string") return null;
  const m = REF.exec(ref);
  return m ? { checkoutId: m[1], attempt: Number(m[2] ?? 0) } : null;
}

// ------------------------------------------------------------------------------------------------ what the page sees

export type PayoutView =
  | { can: "none" } // nothing held for this order
  | { can: "not_yet" } // the match is not settled yet
  | { can: "held"; usd: string; ngn: string } // collecting to a bank is not open: the money waits at the buyer's number
  | { can: "ready"; usd: string; ngn: string } // pick a bank
  | { can: "confirm"; usd: string; ngn: string; accountName: string; bankName: string; last4: string }
  | { can: "waiting_bank"; usd: string; ngn: string; accountName: string; bankName: string; last4: string }
  | { can: "sending"; ngn: string; accountName: string; bankName: string; last4: string }
  | { can: "paid"; ngn: string; accountName: string; bankName: string; last4: string }
  | { can: "failed"; usd: string; ngn: string; reason: string };

// ------------------------------------------------------------------------------------------------ deps

export interface ChainView {
  final: boolean; // the result is final and money back has been paid out to the winning side
  owed: bigint; // a refund the drop kept for this buyer, waiting for claim()
  balance: bigint; // USDC at the buyer's address
}

export interface PayoutDeps {
  bachs(path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: unknown }>;
  session(id: string): Promise<BachsSession | null>;
  store: GuestStore;
  view(rec: GuestRecord): Promise<ChainView>;
  claim(key: Hex, promo: Address): Promise<Hex>;
  /** What can leave the address: its balance less the gas for the move itself. */
  movable(key: Hex): Promise<bigint>;
  move(key: Hex, amount: bigint): Promise<Hex>;
  balance(who: Address): Promise<bigint>;
  diag(kind: string, data: Record<string, unknown>): Promise<void>;
  secret: string | null;
  rate: number;
  enabled: boolean;
  now(): number;
}

type Err = { error: "disabled" | "not_found" | "not_allowed" | "bad_account" | "busy" | "provider"; message: string };
const E = {
  disabled: "Money back is held safely for you at your Tifo number. Collecting to your bank opens soon.",
  not_found: "We could not find this order.",
  not_allowed: "There is nothing to collect on this order right now.",
  bad_account: "We could not find that account. Check the bank and the account number.",
  busy: "This is already on its way. Refresh in a moment.",
  provider: "The bank transfer could not start just now. Your money is safe. Try again in a minute.",
} as const;
const err = (e: Err["error"]): Err => ({ error: e, message: E[e] });

const code = (j: unknown) => (j && typeof j === "object" ? String((j as { error_code?: unknown }).error_code ?? "") : "");
const forbidden = (r: { status: number; json: unknown }) => r.status === 403 || ["FORBIDDEN", "PAYOUTS_NOT_ENABLED", "PAYOUT_CURRENCY_NOT_ENABLED"].includes(code(r.json));

async function load(checkoutId: string, d: PayoutDeps): Promise<GuestRecord | null> {
  if (!isCheckoutId(checkoutId)) return null;
  const s = await d.session(checkoutId);
  const ref = s && s.checkout_id === checkoutId ? parseGuestReference(s.reference) : null;
  if (!ref) return null;
  const rec = await d.store.get(ref.promo, checkoutId);
  return rec && rec.guest === ref.guest ? rec : null;
}

async function save(rec: GuestRecord, d: PayoutDeps, patch: Partial<PayoutInfo>) {
  rec.payout = { ...(rec.payout ?? { state: "account" }), ...patch, at: d.now() };
  rec.updatedAt = d.now();
  await d.store.put(rec);
}

/** What is held for this buyer now, in USDC units, or null while there is nothing to collect yet. */
async function held(rec: GuestRecord, d: PayoutDeps): Promise<bigint | null> {
  if (rec.status !== "bought" && rec.status !== "failed") return null;
  const v = await d.view(rec);
  if (rec.status === "bought" && !v.final) return null; // money back is only known once the result is final
  return v.owed + v.balance;
}

const usd = (units: bigint) => (Number(units) / 1e6).toFixed(2);
const shown = (p: PayoutInfo) => ({ accountName: p.accountName ?? "", bankName: p.bankName ?? "", last4: p.last4 ?? "" });

// ------------------------------------------------------------------------------------------------ status

export async function payoutStatusWith(checkoutId: string, d: PayoutDeps): Promise<PayoutView | Err> {
  const rec = await load(checkoutId, d);
  if (!rec) return err("not_found");
  const p = rec.payout;
  if (p && ["moving", "moved", "sent", "paid", "failed"].includes(p.state) && p.usdc) {
    if (p.state === "sent" && p.payoutId) await refresh(rec, d);
    const q = rec.payout!;
    const ngn = q.ngn ?? "0";
    if (q.state === "moved" && q.destination && !q.confirmed && d.enabled) return { can: "confirm", usd: usd(BigInt(q.usdc!)), ngn, ...shown(q) };
    if (q.state === "paid") return { can: "paid", ngn, ...shown(q) };
    if (q.state === "failed") return { can: "failed", usd: usd(BigInt(q.usdc!)), ngn, reason: q.failure ?? "" };
    if (!d.enabled) return { can: "held", usd: usd(BigInt(q.usdc!)), ngn };
    return { can: "sending", ngn, ...shown(q) };
  }
  const amount = await held(rec, d);
  if (amount === null) return { can: rec.status === "bought" ? "not_yet" : "none" };
  if (amount < MIN_UNITS) return { can: "none" };
  const money = { usd: usd(amount), ngn: nairaFor(amount, d.rate).toString() };
  if (!d.enabled) return { can: "held", ...money };
  if (p?.destination && p.state === "account") return { can: "confirm", ...money, ...shown(p) };
  if (p?.destination && p.state === "waiting_bank") return { can: "waiting_bank", ...money, ...shown(p) };
  return { can: "ready", ...money };
}

/** Asks Bachs where a sent payout stands. Bachs is the only source; a webhook only prompts this. */
async function refresh(rec: GuestRecord, d: PayoutDeps): Promise<void> {
  const p = rec.payout!;
  const r = await d.bachs(`/v1/payouts/${encodeURIComponent(p.payoutId!)}`);
  if (r.status !== 200 || !r.json || typeof r.json !== "object") return;
  const j = r.json as { status?: string; failure_reason?: string | null; reference?: string };
  if (j.reference && j.reference !== p.reference) return;
  if (j.status === "completed") await save(rec, d, { state: "paid" });
  else if (j.status === "failed") {
    await save(rec, d, { state: "failed", failure: (j.failure_reason ?? "").slice(0, 120) });
    await d.diag("guest_payout_failed", { checkoutId: rec.checkoutId, payoutId: p.payoutId, reason: (j.failure_reason ?? "").slice(0, 120) });
  }
}

// ------------------------------------------------------------------------------------------------ account

export async function listBanksWith(d: Pick<PayoutDeps, "bachs">): Promise<{ name: string; code: string }[]> {
  const r = await d.bachs("/v1/reference/banks?country=NG");
  if (r.status !== 200) return [];
  const banks = (r.json as { banks?: unknown })?.banks;
  if (!Array.isArray(banks)) return [];
  return banks
    .filter((b): b is { name: string; code: string } => !!b && typeof b.name === "string" && typeof b.code === "string" && /^[A-Za-z0-9]{2,12}$/.test(b.code))
    .map((b) => ({ name: b.name.slice(0, 80), code: b.code }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Creates (or reuses) the Bachs destination for this bank account and returns the name the bank resolved, to confirm. */
export async function setAccountWith(checkoutId: string, bankCode: string, accountNumber: string, d: PayoutDeps): Promise<PayoutView | Err> {
  if (!d.enabled) return err("disabled");
  if (!/^[A-Za-z0-9]{2,12}$/.test(bankCode) || !/^\d{10}$/.test(accountNumber)) return err("bad_account");
  const rec = await load(checkoutId, d);
  if (!rec) return err("not_found");
  const state = rec.payout?.state;
  if (state && !["account", "waiting_bank", "failed"].includes(state)) return err("busy");
  if (state !== "failed") {
    const amount = await held(rec, d);
    if (amount === null || amount < MIN_UNITS) return err("not_allowed");
  }
  const acct = createHash("sha256").update(`${bankCode}:${accountNumber}`).digest("hex").slice(0, 32);
  let dest = rec.payout?.acct === acct && rec.payout.destination ? rec.payout.destination : null;
  let accountName = rec.payout?.accountName ?? "";
  let bankName = rec.payout?.bankName ?? "";
  if (!dest) {
    const r = await d.bachs("/v1/payouts/destinations", { type: "bank_account", currency: "NGN", bank_code: bankCode, account_number: accountNumber, name: `tifo ${checkoutId}`.slice(0, 60) });
    if (forbidden(r)) return held_(rec, d, "destination", r);
    const j = (r.json ?? {}) as { id?: unknown; account_name?: unknown; bank_name?: unknown; status?: unknown };
    if ((r.status !== 200 && r.status !== 201) || typeof j.id !== "string" || !/^pd_[A-Za-z0-9]+$/.test(j.id)) {
      if (r.status === 400 || r.status === 404 || r.status === 422) return err("bad_account");
      return err("provider");
    }
    if (j.status === "rejected" || typeof j.account_name !== "string" || !j.account_name.trim()) return err("bad_account");
    dest = j.id;
    accountName = j.account_name.trim().slice(0, 80);
    bankName = typeof j.bank_name === "string" ? j.bank_name.slice(0, 80) : "";
  }
  // A new account after a failed payout gets a new reference, since Bachs never reuses one.
  const attempt = state === "failed" ? (rec.payout?.attempt ?? 0) + 1 : rec.payout?.attempt;
  const keep = state === "failed" ? "moved" : "account";
  await save(rec, d, { state: keep, destination: dest, acct, bankCode, bankName, accountName, last4: accountNumber.slice(-4), attempt, failure: undefined, payoutId: undefined, confirmed: false });
  return payoutStatusWith(checkoutId, d);
}

// ------------------------------------------------------------------------------------------------ collect

const inflight = new Map<string, Promise<PayoutView | Err>>();

/** The buyer confirmed the account name: claim, move to the float, pay the naira. Safe to call any number of times. */
export function collectWith(checkoutId: string, d: PayoutDeps): Promise<PayoutView | Err> {
  const live = inflight.get(checkoutId);
  if (live) return live;
  const p = collect(checkoutId, d).finally(() => inflight.delete(checkoutId));
  inflight.set(checkoutId, p);
  return p;
}

async function collect(checkoutId: string, d: PayoutDeps): Promise<PayoutView | Err> {
  if (!d.enabled) return err("disabled");
  const rec = await load(checkoutId, d);
  if (!rec) return err("not_found");
  let p = rec.payout;
  if (!p?.destination) return err("not_allowed");
  if (p.state === "sent" || p.state === "paid") return payoutStatusWith(checkoutId, d);
  if (p.state === "failed") return err("not_allowed"); // pick an account first
  if (!p.confirmed) {
    await save(rec, d, { confirmed: true });
    p = rec.payout!;
  }

  // The destination must be usable before any money moves, and before any payout (Bachs may review a new account first).
  const r0 = await d.bachs(`/v1/payouts/destinations/${encodeURIComponent(p.destination!)}`);
  if (forbidden(r0)) return held_(rec, d, "destination_read", r0);
  if (r0.status !== 200) return err("provider");
  const dj = (r0.json ?? {}) as { is_usable?: unknown; status?: unknown };
  if (dj.status === "rejected") {
    if (p.state === "account" || p.state === "waiting_bank") await save(rec, d, { state: "account", destination: undefined, acct: undefined, confirmed: false });
    else await save(rec, d, { state: "failed", failure: "account rejected" }); // the money already moved: pick another account
    return err("bad_account");
  }
  if (dj.is_usable !== true) {
    if (p.state === "account") await save(rec, d, { state: "waiting_bank" });
    return payoutStatusWith(checkoutId, d);
  }

  const key = guestKey(openPhone(rec.phone, checkoutId, d.secret), d.secret);
  if (privateKeyToAccount(key).address !== rec.guest) {
    await d.diag("guest_key_mismatch", { checkoutId, step: "payout" });
    return err("provider");
  }

  // 1 and 2: claim and move, with the amount fixed and written down before the USDC leaves.
  if (p.state === "account" || p.state === "waiting_bank") {
    const amount = await held(rec, d);
    if (amount === null || amount < MIN_UNITS) return err("not_allowed");
    const v = await d.view(rec);
    let claimTx: Hex | undefined;
    if (v.owed > 0n) claimTx = await d.claim(key, rec.promo);
    const usdc = await d.movable(key);
    if (usdc < MIN_UNITS) return err("not_allowed");
    await save(rec, d, { state: "moving", usdc: usdc.toString(), ngn: nairaFor(usdc, d.rate).toString(), claimTx });
    p = rec.payout!;
  }
  if (p.state === "moving") {
    // If the address still holds the amount, the move has not landed: send it. Otherwise it already went.
    if ((await d.balance(rec.guest)) >= BigInt(p.usdc!)) {
      const moveTx = await d.move(key, BigInt(p.usdc!));
      await save(rec, d, { state: "moved", moveTx });
    } else await save(rec, d, { state: "moved" });
    p = rec.payout!;
  }

  // 3: the naira payout, once per reference.
  const reference = payoutReference(checkoutId, p.attempt ?? 0);
  const found = await d.bachs(`/v1/payouts?reference=${encodeURIComponent(reference)}`);
  if (forbidden(found)) return held_(rec, d, "payout_read", found);
  const existing = listed(found.json).find((x) => x.reference === reference);
  if (existing?.id) {
    await save(rec, d, { state: "sent", payoutId: existing.id, reference });
    return payoutStatusWith(checkoutId, d);
  }
  if (found.status !== 200) return err("provider");

  let r = await d.bachs("/v1/payouts", { destination: p.destination, amount: `${p.ngn}.00`, reference, narration: "Tifo refund" }, { "Idempotency-Key": `${reference}-ngn` });
  let route: "ngn" | "quote" = "ngn";
  if (forbidden(r)) return held_(rec, d, "payout", r);
  if (code(r.json) === "INSUFFICIENT_BALANCE") {
    // Not enough naira at Bachs: convert the dollars instead.
    route = "quote";
    const q = await d.bachs("/v1/payouts/quotes", { from_currency: "USD", to_currency: "NGN", amount: usd(BigInt(p.usdc!)), payout_method: "BANK_TRANSFER" });
    if (forbidden(q)) return held_(rec, d, "quote", q);
    const quoteId = (q.json as { quote_id?: unknown } | null)?.quote_id;
    if ((q.status !== 200 && q.status !== 201) || typeof quoteId !== "string") {
      await d.diag("guest_payout_quote_failed", { checkoutId, status: q.status, code: code(q.json) });
      return err("provider");
    }
    r = await d.bachs("/v1/payouts", { destination: p.destination, quote_id: quoteId, reference, narration: "Tifo refund" }, { "Idempotency-Key": `${reference}-usd` });
    if (forbidden(r)) return held_(rec, d, "payout_quote", r);
  }
  const j = (r.json ?? {}) as { id?: unknown };
  if ((r.status === 200 || r.status === 201) && typeof j.id === "string") {
    await save(rec, d, { state: "sent", payoutId: j.id, reference, route });
    return payoutStatusWith(checkoutId, d);
  }
  if (/already exists/i.test(String((r.json as { detail?: unknown } | null)?.detail ?? ""))) return err("busy"); // the reference lookup finds it next time
  await d.diag("guest_payout_refused", { checkoutId, status: r.status, code: code(r.json), route });
  return err("provider");
}

// After Bachs says payouts are not permitted, the page shows "held safely" for a while instead of a form that cannot work.
let blockedAt = 0;
const blocked = () => Date.now() - blockedAt < 15 * 60_000;

async function held_(rec: GuestRecord, d: PayoutDeps, step: string, r: { status: number; json: unknown }): Promise<Err> {
  blockedAt = Date.now();
  await d.diag("guest_payout_not_permitted", { checkoutId: rec.checkoutId, step, status: r.status, code: code(r.json) });
  return err("disabled");
}

function listed(j: unknown): { id?: string; reference?: string }[] {
  const arr = Array.isArray(j) ? j : j && typeof j === "object" ? ((j as { data?: unknown; items?: unknown; payouts?: unknown }).data ?? (j as { items?: unknown }).items ?? (j as { payouts?: unknown }).payouts) : null;
  return Array.isArray(arr) ? (arr as { id?: string; reference?: string }[]) : [];
}

// ------------------------------------------------------------------------------------------------ real deps

function realDeps(): PayoutDeps {
  const cfg = nairaConfig() as NairaConfig;
  const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain, transport });
  return {
    bachs: (path, body, headers) => bachsCall(cfg, path, body, headers),
    session: (id) => fetchSession(cfg, id),
    store: blobStore,
    async view(rec) {
      const c = { address: rec.promo, abi: tifoPromoAbi } as const;
      const [finalOutcome, refundCursor, ordersCount, owed] = await publicClient.multicall({
        allowFailure: false,
        contracts: [{ ...c, functionName: "finalOutcome" }, { ...c, functionName: "refundCursor" }, { ...c, functionName: "ordersCount" }, { ...c, functionName: "owed", args: [rec.guest] }],
      });
      return { final: Number(finalOutcome) !== 0 && (refundCursor as bigint) >= (ordersCount as bigint), owed: owed as bigint, balance: await usdcBalance(rec.guest) };
    },
    async claim(key, promo) {
      const w = wallet(key);
      const { request } = await publicClient.simulateContract({ account: w.account, address: promo, abi: tifoPromoAbi, functionName: "claim" });
      const h = await w.writeContract(request);
      if ((await publicClient.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error("The claim did not go through.");
      return h;
    },
    async movable(key) {
      // Arc gas is paid from the same USDC, so the move leaves enough behind to pay for itself (twice the estimate).
      const who = privateKeyToAccount(key).address;
      const bal = await usdcBalance(who);
      if (bal === 0n) return 0n;
      const [gas, price] = await Promise.all([publicClient.estimateContractGas({ account: who, address: USDC, abi: erc20Abi, functionName: "transfer", args: [cfg.float, 1n] }), publicClient.getGasPrice()]);
      const fee = (gas * price * 2n + 999_999_999_999n) / 1_000_000_000_000n; // wei (18 decimals) to USDC units (6)
      return bal > fee ? bal - fee : 0n;
    },
    async move(key, amount) {
      const w = wallet(key);
      const h = await w.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [cfg.float, amount] });
      if ((await publicClient.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error("The move did not go through.");
      return h;
    },
    balance: usdcBalance,
    diag: (kind, data) => diagEvent(kind, data),
    secret: guestSecret(),
    rate: cfg?.rate ?? 0,
    enabled: payoutsOn() && !blocked(),
    now: () => Math.floor(Date.now() / 1000),
  };
}

const off = (): Err => err("disabled");
export const payoutStatus = (id: string) => (nairaConfig() ? payoutStatusWith(id, realDeps()) : Promise.resolve(off()));
export const setAccount = (id: string, bank: string, acct: string) => (nairaConfig() ? setAccountWith(id, bank, acct, realDeps()) : Promise.resolve(off()));
export const collectMoneyBack = (id: string) => (nairaConfig() ? collectWith(id, realDeps()) : Promise.resolve(off()));

let banks: { at: number; list: { name: string; code: string }[] } | null = null;
export async function listBanks(): Promise<{ name: string; code: string }[]> {
  const cfg = nairaConfig();
  if (!cfg || !payoutsOn()) return [];
  if (banks && Date.now() - banks.at < 3600_000 && banks.list.length) return banks.list;
  const list = await listBanksWith({ bachs: (path, body, headers) => bachsCall(cfg, path, body, headers) });
  banks = { at: Date.now(), list };
  return list;
}

/** For the webhook: a payout event names a reference; the state is read back from Bachs. */
export async function payoutEvent(reference: unknown): Promise<boolean> {
  const r = parsePayoutReference(reference);
  if (!r || !nairaConfig()) return false;
  await payoutStatusWith(r.checkoutId, realDeps());
  return true;
}

