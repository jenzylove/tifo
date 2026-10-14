// Pay in naira, through Bachs. Server only.
// The buyer pays naira (bank transfer or card) on a Bachs hosted checkout. When Bachs confirms the payment, the matching
// USDC is released from a pre funded float contract (TifoFloat) to the buyer's Tifo wallet. Nothing else changes: the
// checkout then sees the balance and the buyer confirms the purchase.
// The rule everywhere: any doubt means no release. A webhook only names a checkout; the money is decided by asking
// Bachs for that checkout again, and the contract refuses to pay one reference twice.
// Money is integers throughout: USDC in 6 decimal units and naira in kobo, both bigint. Strings only at the edge.
import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BaseError, ContractFunctionRevertedError, createWalletClient, getAddress, isAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "./abi";
import { USDC, chain, publicClient, transport } from "./chain";
import { tifoFloatAbi } from "./nairaAbi";

const SANDBOX = "https://sandbox-api.bachs.io";
const LIVE = "https://api.bachs.io";

export interface NairaConfig {
  key: string; // Bachs secret key (sk_sandbox_ or sk_live_)
  webhookSecret: string; // signing secret of our webhook endpoint at Bachs; empty until set
  rate: number; // naira per 1 USD
  float: Address; // the TifoFloat contract
  maxUsd: number; // the most one naira payment may buy
  base: string; // sandbox or live API, decided by the key
}

/** Reads the settings from the environment on each call, so a test (or a redeploy) can change them. */
export function nairaConfig(env: Record<string, string | undefined> = process.env): NairaConfig | null {
  const clean = (v?: string) => (v ?? "").trim().replace(/^["']|["']$/g, "");
  const key = clean(env.BACHS_SECRET_KEY);
  const rate = Number(clean(env.NAIRA_PER_USD));
  const float = clean(env.NAIRA_FLOAT);
  if (!key || !Number.isFinite(rate) || rate < 0.01 || !isAddress(float)) return null;
  // Real money for real money, test money for test money. A sandbox key on the real network would hand out real USDC
  // for pretend naira, and a live key on the practice network would take real naira for test USDC.
  const realNetwork = clean(env.NEXT_PUBLIC_NETWORK) !== "testnet";
  if (realNetwork !== key.startsWith("sk_live_")) return null;
  const max = Number(clean(env.NAIRA_MAX_USD) || 50);
  return {
    key,
    webhookSecret: clean(env.BACHS_WEBHOOK_SECRET),
    rate,
    float: getAddress(float),
    maxUsd: Number.isFinite(max) && max >= 1 ? max : 50,
    base: key.startsWith("sk_live_") ? LIVE : SANDBOX,
  };
}

/**
 * What still has to be set before naira payments can run, as plain names. Never a value: it only says which setting is
 * absent, or that the key is for the other network (a test key on the real site, or a live key on the practice site).
 */
export function nairaMissing(env: Record<string, string | undefined> = process.env): string[] {
  const clean = (v?: string) => (v ?? "").trim().replace(/^["']|["']$/g, "");
  const key = clean(env.BACHS_SECRET_KEY);
  const rate = Number(clean(env.NAIRA_PER_USD));
  const out: string[] = [];
  if (!key) out.push("key");
  else if ((clean(env.NEXT_PUBLIC_NETWORK) !== "testnet") !== key.startsWith("sk_live_")) out.push(key.startsWith("sk_live_") ? "live key on the practice site" : "test key on the real site");
  if (!Number.isFinite(rate) || rate < 0.01) out.push("rate");
  if (!isAddress(clean(env.NAIRA_FLOAT))) out.push("float");
  if (!clean(env.BACHS_WEBHOOK_SECRET)) out.push("webhook secret");
  return out;
}

/** True only when the key, the rate and the float address are all set. */
export function nairaEnabled(): boolean {
  return nairaConfig() !== null;
}

// ------------------------------------------------------------------------------------------------ money

/** Kobo to the decimal string Bachs uses, 500000n to "5000.00". */
export function formatKobo(kobo: bigint): string {
  return `${kobo / 100n}.${(kobo % 100n).toString().padStart(2, "0")}`;
}

/** A Bachs amount ("5000.00") to kobo. Anything that is not a plain decimal with at most 2 real decimals gives null. */
export function parseKobo(s: unknown): bigint | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (/[1-9]/.test(frac.slice(2))) return null; // a third decimal that is not zero is not an amount of kobo
  return BigInt(m[1]) * 100n + BigInt(frac.slice(0, 2).padEnd(2, "0"));
}

/** What `usdUnits` of USDC costs in kobo at `rate` naira per dollar, rounded up to the next 10 naira. */
export function quoteKobo(usdUnits: bigint, rate: number): bigint {
  if (usdUnits <= 0n) throw new Error("The amount must be more than zero.");
  const perUsd = BigInt(Math.round(rate * 100)); // kobo for one dollar, a whole number
  if (!Number.isFinite(rate) || perUsd <= 0n) throw new Error("The rate must be more than zero.");
  const kobo = (usdUnits * perUsd + 999_999n) / 1_000_000n; // up to the next kobo
  return ((kobo + 999n) / 1000n) * 1000n; // up to the next 10 naira
}

/** The naira price of `usdUnits` of USDC as a decimal string, rounded UP to the next 10 naira. */
export function quote(usdUnits: bigint, rate: number): string {
  return formatKobo(quoteKobo(usdUnits, rate));
}

/** A dollar amount typed or computed in the browser to USDC units, rounded UP to the next cent. Null if it is not a sane amount. */
export function usdToUnits(usd: number): bigint | null {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0 || usd > 1e9) return null;
  const micro = BigInt(Math.round(usd * 1e6));
  return ((micro + 9_999n) / 10_000n) * 10_000n;
}

// ------------------------------------------------------------------------------------------------ reference

// Our own order reference, sent to Bachs and read back from it: who gets the USDC, how much, and what they paid for it.
// tifo:<wallet>:<usdc units>:<kobo>:<8 random hex>. The random tail keeps every reference unique (Bachs wants that).
export interface Reference {
  wallet: Address;
  usdcUnits: bigint;
  ngn: bigint; // the price in kobo
  nonce: string;
}

const REF = /^tifo:(0x[0-9a-fA-F]{40}):([1-9]\d{0,19}):([1-9]\d{0,19}):([0-9a-f]{8})$/;

export function makeReference({ wallet, usdcUnits, ngn }: { wallet: string; usdcUnits: bigint; ngn: bigint }): string {
  if (!isAddress(wallet)) throw new Error("That is not a wallet address.");
  if (usdcUnits <= 0n || ngn <= 0n) throw new Error("The amounts must be more than zero.");
  const ref = `tifo:${wallet.toLowerCase()}:${usdcUnits}:${ngn}:${randomBytes(4).toString("hex")}`;
  if (!parseReference(ref)) throw new Error("That reference is not valid.");
  return ref;
}

/** Reads a reference back. Strict: anything that is not exactly the form above gives null. */
export function parseReference(ref: unknown): Reference | null {
  if (typeof ref !== "string" || ref.length > 128) return null;
  const m = REF.exec(ref);
  if (!m || !isAddress(m[1])) return null; // isAddress also checks the capitals of a checksummed address
  return { wallet: getAddress(m[1]), usdcUnits: BigInt(m[2]), ngn: BigInt(m[3]), nonce: m[4] };
}

// ------------------------------------------------------------------------------------------------ webhook

const TOLERANCE = 300; // seconds a delivery may be off from our clock

/**
 * Checks the X-Bachs-Signature-V2 header: `t=<unix seconds>,v1=<sig>[,v1=<sig>...]`. Each signature is the HMAC SHA256
 * (hex) of "<t>.<raw body>" under the endpoint's signing secret. More than one v1 is sent while a secret is being rotated,
 * so any one of them may match. Pass the body exactly as it arrived, not parsed and written back.
 */
export function verifyWebhook(rawBody: string, header: string | null | undefined, secret: string, nowSeconds: number): boolean {
  if (!secret || !header) return false;
  let t: string | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") {
      if (t !== null) return false; // two timestamps: refuse rather than guess
      t = v;
    } else if (k === "v1") sigs.push(v);
  }
  if (t === null || !/^\d{1,12}$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(nowSeconds - Number(t)) > TOLERANCE) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest();
  let ok = false;
  for (const s of sigs) {
    if (/^[0-9a-fA-F]{64}$/.test(s) && timingSafeEqual(expected, Buffer.from(s, "hex"))) ok = true; // look at all of them
  }
  return ok;
}

// ------------------------------------------------------------------------------------------------ the Bachs session

// The parts of GET /v1/checkout-sessions/{id} that we read. Everything else Bachs sends is ignored.
export interface BachsCharge {
  payment_id?: string;
  status?: string; // created, processing, succeeded, accepted, failed, expired, cancelled, refunded, partially_refunded, auto_refunded, underpaid, overpaid
  amount?: string | null; // requested, in major units
  amount_paid?: string | null; // what actually arrived
  currency?: string;
}

export interface BachsSession {
  checkout_id?: string;
  status?: string; // open, completed, expired, cancelled
  payment_status?: string | null;
  reference?: string | null;
  currency?: string;
  charge?: BachsCharge | null; // null while nothing has been paid
}

export type Payment = "paid" | "pending" | "not_paid";

const PAID = new Set(["succeeded", "accepted", "overpaid"]);
const WAITING = new Set(["created", "processing"]);
const lower = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : "");

/**
 * Whether the money is really here. "paid" only when the charge succeeded, was accepted or was overpaid, in naira, for at
 * least the price written in our reference. "pending" means it may still arrive. Everything else, including a status we
 * do not know, is "not_paid".
 */
export function paymentState(s: BachsSession | null | undefined): Payment {
  if (!s || typeof s !== "object") return "not_paid";
  const ref = parseReference(s.reference);
  if (!ref) return "not_paid"; // not one of ours, or damaged: never pay on it
  const open = lower(s.status) === "open";
  const c = s.charge;
  if (!c || typeof c !== "object") return open ? "pending" : "not_paid";
  const st = lower(c.status);
  if (PAID.has(st)) {
    if (lower(c.currency) !== "ngn") return "not_paid";
    if (s.currency != null && lower(s.currency) !== "ngn") return "not_paid";
    // "succeeded" means paid in full, so the requested amount stands in if Bachs leaves the paid amount out.
    // "accepted" can be a short payment taken as final, so it needs a real paid amount.
    const paid = parseKobo(c.amount_paid ?? (st === "succeeded" ? c.amount : null));
    return paid !== null && paid >= ref.ngn ? "paid" : "not_paid";
  }
  if (WAITING.has(st)) return "pending";
  if (st === "failed") return open ? "pending" : "not_paid"; // the hosted page stays open for another try
  return "not_paid"; // underpaid, expired, cancelled, refunded, or anything new
}

export function isPaid(s: BachsSession | null | undefined): boolean {
  return paymentState(s) === "paid";
}

const CHECKOUT_ID = /^chk_[A-Za-z0-9]+$/;
export const isCheckoutId = (id: unknown): id is string => typeof id === "string" && CHECKOUT_ID.test(id);

async function bachs(cfg: NairaConfig, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(cfg.base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Bachs's own record of one checkout. Null when Bachs has never heard of it. */
async function fetchSession(cfg: NairaConfig, id: string): Promise<BachsSession | null> {
  const r = await bachs(cfg, `/v1/checkout-sessions/${id}`);
  if (r.status === 404) return null;
  if (r.status !== 200 || !r.json || typeof r.json !== "object") throw new Error(`Bachs answered ${r.status}`);
  return r.json as BachsSession;
}

// ------------------------------------------------------------------------------------------------ the float

const usdcBalance = (who: Address) => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
const floatRead = (cfg: NairaConfig, functionName: "perRelease" | "perDay" | "releasedToday") =>
  publicClient.readContract({ address: cfg.float, abi: tifoFloatAbi, functionName });
const alreadyReleased = (cfg: NairaConfig, ref: Hex) => publicClient.readContract({ address: cfg.float, abi: tifoFloatAbi, functionName: "released", args: [ref] });

/** The agent's key is the float's releaser. Same wallet as lib/agent.ts, built here so that file stays untouched. */
function agentWallet() {
  const pk = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("AGENT_PRIVATE_KEY is not set");
  return createWalletClient({ account: privateKeyToAccount(pk), chain, transport });
}

/** A short, safe description of a failure for the logs: never the request URL (it can carry a token) or any key. */
export function why(e: unknown): string {
  const m = e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e);
  return m.slice(0, 160);
}

function revertName(e: unknown): string | undefined {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError && r.data?.errorName) return r.data.errorName;
  }
  return /AlreadyReleased|OverLimit/.exec(e instanceof Error ? e.message : "")?.[0];
}

// ------------------------------------------------------------------------------------------------ start

export type Started =
  | { ok: true; checkoutUrl: string; checkoutId: string; ngn: string; rate: number }
  | { ok: false; error: "disabled" | "bad_amount" | "too_large" | "float_short" | "provider" };

/**
 * Opens a Bachs checkout for `usdUnits` of USDC for `wallet`. Refuses first if the float could not pay it out
 * (not enough USDC, or over its release limits), so nobody pays naira we cannot honour.
 */
export async function startCheckout({ wallet, usdUnits, promo, origin }: { wallet: Address; usdUnits: bigint; promo?: Address; origin: string }): Promise<Started> {
  const cfg = nairaConfig();
  if (!cfg) return { ok: false, error: "disabled" };
  if (!isAddress(wallet) || usdUnits < 1_000_000n || usdUnits > BigInt(Math.floor(cfg.maxUsd * 100)) * 10_000n) return { ok: false, error: "bad_amount" };

  const [balance, perRelease, perDay, today] = await Promise.all([usdcBalance(cfg.float), floatRead(cfg, "perRelease"), floatRead(cfg, "perDay"), floatRead(cfg, "releasedToday")]);
  if (usdUnits > perRelease) return { ok: false, error: "too_large" };
  if (balance < usdUnits || today + usdUnits > perDay) return { ok: false, error: "float_short" };

  const ngn = quoteKobo(usdUnits, cfg.rate);
  const back = `${origin.replace(/\/$/, "")}${promo ? `/p/${promo}` : "/"}`; // Bachs adds ?checkout_id= to the success address
  const r = await bachs(cfg, "/v1/checkout-sessions", {
    pricing: { currency: "NGN", amount: formatKobo(ngn) },
    reference: makeReference({ wallet, usdcUnits: usdUnits, ngn }),
    success_url: back,
    cancel_url: back,
    payment_method_types: ["NGN_BANK_TRANSFER", "NGN_CARD"],
    expires_in_minutes: 30,
    metadata: { wallet, usdc_units: usdUnits.toString(), ...(promo ? { promo } : {}) },
  });
  const j = (r.json ?? {}) as { checkout_id?: unknown; checkout_url?: unknown };
  if (r.status !== 201 && r.status !== 200) {
    console.error("naira: Bachs refused the checkout", r.status);
    return { ok: false, error: "provider" };
  }
  let url: URL | null = null;
  try {
    url = new URL(String(j.checkout_url));
  } catch {}
  if (!isCheckoutId(j.checkout_id) || !url || url.protocol !== "https:") return { ok: false, error: "provider" };
  return { ok: true, checkoutUrl: url.toString(), checkoutId: j.checkout_id, ngn: formatKobo(ngn), rate: cfg.rate };
}

// ------------------------------------------------------------------------------------------------ release

export interface ReleaseResult {
  state: "released" | "already" | "pending" | "not_paid" | "float_short";
  hash?: Hex;
}

// One call per checkout at a time on this server, and one release transaction at a time, so a webhook and a page
// check landing together cannot send two transactions (or reuse a nonce). The contract is still the final judge.
const inflight = new Map<string, Promise<ReleaseResult>>();
let lane: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = lane.then(fn);
  lane = run.catch(() => {});
  return run;
}

/**
 * Pays out the USDC for one Bachs checkout, if and only if Bachs says it is paid. Safe to call any number of times, from
 * the webhook and from the buyer's page: the contract pays each checkout once, and "already paid" counts as success.
 * The checkout id is all we take from a webhook. The facts come from Bachs.
 */
export function releaseFor(checkoutId: string): Promise<ReleaseResult> {
  const live = inflight.get(checkoutId);
  if (live) return live;
  const p = release(checkoutId).finally(() => inflight.delete(checkoutId));
  inflight.set(checkoutId, p);
  return p;
}

async function release(checkoutId: string): Promise<ReleaseResult> {
  const cfg = nairaConfig();
  if (!cfg) throw new Error("Naira payments are not set up.");
  if (!isCheckoutId(checkoutId)) return { state: "not_paid" };

  const session = await fetchSession(cfg, checkoutId);
  if (!session || session.checkout_id !== checkoutId) return { state: "not_paid" };
  const paid = paymentState(session);
  if (paid !== "paid") return { state: paid === "pending" ? "pending" : "not_paid" };

  const ref = parseReference(session.reference)!; // paymentState only says "paid" for a valid reference
  const id = keccak256(toBytes(checkoutId));
  if (await alreadyReleased(cfg, id)) return { state: "already" };
  if ((await usdcBalance(cfg.float)) < ref.usdcUnits) return { state: "float_short" };

  return oneAtATime(async (): Promise<ReleaseResult> => {
    const w = agentWallet();
    let hash: Hex;
    try {
      const { request } = await publicClient.simulateContract({ account: w.account, address: cfg.float, abi: tifoFloatAbi, functionName: "release", args: [id, ref.wallet, ref.usdcUnits] });
      hash = await w.writeContract(request);
    } catch (e) {
      const name = revertName(e);
      if (name === "AlreadyReleased") return { state: "already" };
      if (name === "OverLimit") return { state: "float_short" }; // the day's limit: it clears after midnight UTC or when the owner raises it
      throw e;
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "success") return { state: "released", hash };
    // A copy of this same release from somewhere else got in first and ours reverted: the buyer was paid once.
    if (await alreadyReleased(cfg, id)) return { state: "already", hash };
    throw new Error("The release transaction failed.");
  });
}
