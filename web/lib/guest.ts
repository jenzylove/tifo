// Pay in naira without a wallet. Server only.
// A buyer who opened a drop inside Instagram or WhatsApp (where passkeys fail) gives a phone number, picks a club and
// pays naira on the Bachs page. Their buyer address is a key the server derives from a server secret and that phone
// number, so the same number always lands on the same address and nobody else can spend from it.
// When Bachs confirms the money (asked again here, never taken from a webhook), the float sends the price plus a little
// gas to that address, and the server buys on the drop from it. The order on chain belongs to the buyer's address, so
// any money back is paid there by the contract itself and held for them.
// The rule everywhere: any doubt means no move. A paid checkout completes once: the float refuses a second release for
// the same checkout, the drop refuses a second order with the same reference, and this file records each step.
import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { BlobNotFoundError, head, list, put } from "@vercel/blob";
import { BaseError, ContractFunctionRevertedError, createWalletClient, erc20Abi, getAddress, isAddress, keccak256, parseAbiItem, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tifoPromoAbi } from "./abi";
import { USDC, chain, publicClient, transport } from "./chain";
import { alreadyReleased, fetchSession, floatRoom, formatKobo, isCheckoutId, nairaConfig, openSession, paidAgainst, priceKobo, releaseFloat, usdcBalance, why, type BachsSession, type NairaConfig, type ReleaseResult } from "./naira";
import { precheck } from "./precheck";
import { listPromos } from "./promos";

// ------------------------------------------------------------------------------------------------ settings

const clean = (v?: string) => (v ?? "").trim().replace(/^["']|["']$/g, "");

/** The server secret the guest keys come from. At least 32 characters. Changing it loses every guest's address. */
export function guestSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = clean(env.GUEST_SECRET);
  return s.length >= 32 ? s : null;
}

/** USDC units sent with each order for the buyer address's gas (Arc gas is paid in USDC). Default 0.05, at most 1. */
export function gasUnits(env: Record<string, string | undefined> = process.env): bigint {
  const n = Number(clean(env.GUEST_GAS_USD) || 0.05);
  if (!Number.isFinite(n) || n < 0.01 || n > 1) return 50_000n;
  return BigInt(Math.round(n * 1e6));
}

/** Guest checkout runs only with naira payments set up, a guest secret, and somewhere to keep the order. */
export function guestEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return nairaConfig(env) !== null && guestSecret(env) !== null && Boolean(clean(env.BLOB_READ_WRITE_TOKEN));
}

// ------------------------------------------------------------------------------------------------ phone

/**
 * A phone number to E.164 (+2348031234567). Nigerian numbers may be typed the local way (0803 123 4567, 803 123 4567,
 * 2348031234567). Other countries need the + in front. Null for anything that is not a plausible number.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const s = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(s)) return null;
  const plus = s.startsWith("+");
  const d = s.replace(/\D/g, "");
  const ng = (local: string) => (/^[789][01]\d{8}$/.test(local) ? `+234${local}` : null);
  if (plus) {
    if (d.startsWith("234")) return ng(d.slice(3).replace(/^0/, ""));
    return /^[1-9]\d{7,14}$/.test(d) ? `+${d}` : null;
  }
  if (d.length === 11 && d.startsWith("0")) return ng(d.slice(1));
  if (d.length === 13 && d.startsWith("234")) return ng(d.slice(3));
  if (d.length === 10) return ng(d);
  return null;
}

// ------------------------------------------------------------------------------------------------ keys

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // secp256k1 order

/** The buyer's private key: HMAC SHA256 of "tifo-guest:<E.164 phone>" under the guest secret. Never logged, never sent. */
export function guestKey(phone: string, secret: string | null = guestSecret()): Hex {
  if (!secret) throw new Error("GUEST_SECRET is not set");
  const e164 = normalizePhone(phone);
  if (!e164) throw new Error("That is not a phone number.");
  const k = createHmac("sha256", secret).update(`tifo-guest:${e164}`, "utf8").digest("hex");
  const n = BigInt(`0x${k}`);
  if (n === 0n || n >= N) throw new Error("That key is not usable."); // about one chance in 2^128
  return `0x${k}`;
}

export const guestAddress = (phone: string, secret: string | null = guestSecret()): Address => privateKeyToAccount(guestKey(phone, secret)).address;

/** The secret behind a guest order's on chain reference. The drop page and the unlock route accept it like a browser's own. */
export function orderSecret(checkoutId: string, secret: string | null = guestSecret()): Hex {
  if (!secret) throw new Error("GUEST_SECRET is not set");
  return `0x${createHmac("sha256", secret).update(`tifo-guest-order:${checkoutId}`, "utf8").digest("hex")}`;
}
export const orderRefFor = (checkoutId: string, secret: string | null = guestSecret()): Hex => keccak256(orderSecret(checkoutId, secret));

/** The float's once only key for a checkout: the same one the wallet top up uses, so one checkout can never be paid twice. */
export const floatRefFor = (checkoutId: string): Hex => keccak256(toBytes(checkoutId));

// The phone number is kept sealed with a key from the guest secret, bound to the checkout it belongs to.
const sealKey = (secret: string) => createHash("sha256").update(`tifo-guest-seal:${secret}`).digest();

export function sealPhone(phone: string, checkoutId: string, secret: string | null = guestSecret()): string {
  if (!secret) throw new Error("GUEST_SECRET is not set");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", sealKey(secret), iv);
  c.setAAD(Buffer.from(checkoutId, "utf8"));
  const body = Buffer.concat([c.update(phone, "utf8"), c.final()]);
  return `g1.${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url")}`;
}

export function openPhone(sealed: string, checkoutId: string, secret: string | null = guestSecret()): string {
  if (!secret) throw new Error("GUEST_SECRET is not set");
  if (!sealed.startsWith("g1.")) throw new Error("unknown phone format");
  const raw = Buffer.from(sealed.slice(3), "base64url");
  const d = createDecipheriv("aes-256-gcm", sealKey(secret), raw.subarray(0, 12));
  d.setAAD(Buffer.from(checkoutId, "utf8"));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

// ------------------------------------------------------------------------------------------------ reference

// A guest checkout's reference: tg:<buyer address>:<drop address>:<side>:<USDC units to buy>:<kobo>:<8 random hex>.
// A different shape from the wallet top up (tifo:...), so neither flow ever acts on the other's checkout.
export interface GuestReference {
  guest: Address;
  promo: Address;
  side: 0 | 1;
  amount: bigint; // what the order pays the drop, in USDC units (the gas sent with it is not part of it)
  ngn: bigint; // the price in kobo
  nonce: string;
}

const GREF = /^tg:([0-9a-f]{40}):([0-9a-f]{40}):([01]):([1-9]\d{0,14}):([1-9]\d{0,14}):([0-9a-f]{8})$/;

export function makeGuestReference(r: Omit<GuestReference, "nonce">): string {
  if (!isAddress(r.guest) || !isAddress(r.promo)) throw new Error("That is not an address.");
  if ((r.side !== 0 && r.side !== 1) || r.amount <= 0n || r.ngn <= 0n) throw new Error("That reference is not valid.");
  const ref = `tg:${r.guest.slice(2).toLowerCase()}:${r.promo.slice(2).toLowerCase()}:${r.side}:${r.amount}:${r.ngn}:${randomBytes(4).toString("hex")}`;
  if (!parseGuestReference(ref)) throw new Error("That reference is not valid.");
  return ref;
}

/** Strict: anything that is not exactly the form above gives null. */
export function parseGuestReference(ref: unknown): GuestReference | null {
  if (typeof ref !== "string" || ref.length > 128) return null;
  const m = GREF.exec(ref);
  if (!m) return null;
  return { guest: getAddress(`0x${m[1]}`), promo: getAddress(`0x${m[2]}`), side: Number(m[3]) as 0 | 1, amount: BigInt(m[4]), ngn: BigInt(m[5]), nonce: m[6] };
}

// ------------------------------------------------------------------------------------------------ the order record

export type GuestStatus = "started" | "funded" | "bought" | "offer_moved" | "failed";

export interface GuestRecord {
  v: 1;
  checkoutId: string;
  promo: Address;
  guest: Address;
  side: 0 | 1;
  amount: string; // USDC units the order pays
  gas: string; // USDC units sent along for gas
  ngn: string; // kobo
  rateBps: number; // the offer the buyer saw
  referrer?: Address;
  phone: string; // sealed
  at: number; // unix seconds
  status: GuestStatus;
  fundTx?: Hex;
  tx?: Hex;
  reason?: string;
  updatedAt: number;
  payout?: PayoutInfo; // collecting money back to a bank in naira (lib/guestPayout.ts)
}

export type PayoutState = "account" | "waiting_bank" | "moving" | "moved" | "sent" | "paid" | "failed";

export interface PayoutInfo {
  state: PayoutState;
  destination?: string; // Bachs payout destination (pd_...)
  acct?: string; // hash of bank code and account number, to reuse a destination
  bankCode?: string;
  bankName?: string;
  accountName?: string;
  last4?: string; // the only part of the account number kept
  usdc?: string; // USDC units moved from the buyer's address to the float, fixed before the move
  ngn?: string; // whole naira to pay out, fixed with usdc
  claimTx?: Hex;
  moveTx?: Hex;
  attempt?: number; // a failed payout can be sent again to another account under a new reference
  reference?: string;
  payoutId?: string;
  route?: "ngn" | "quote";
  failure?: string;
  confirmed?: boolean; // the buyer confirmed the account name for the current account
  at?: number;
}

export interface GuestStore {
  get(promo: Address, checkoutId: string): Promise<GuestRecord | null>;
  put(r: GuestRecord): Promise<void>;
  list(promo: Address): Promise<GuestRecord[]>;
}

const recordPath = (promo: string, id: string) => `guest/orders/${promo.toLowerCase()}/${id}.json`;

async function readBlob(url: string): Promise<GuestRecord | null> {
  const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`store answered ${r.status}`);
  return (await r.json()) as GuestRecord;
}

/** Vercel Blob. The files are reachable by address, so the phone number inside is sealed. */
export const blobStore: GuestStore = {
  async get(promo, id) {
    try {
      return await readBlob((await head(recordPath(promo, id))).url);
    } catch (e) {
      if (e instanceof BlobNotFoundError) return null;
      throw e;
    }
  },
  async put(r) {
    await put(recordPath(r.promo, r.checkoutId), JSON.stringify(r), { access: "public", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 });
  },
  async list(promo) {
    const { blobs } = await list({ prefix: `guest/orders/${promo.toLowerCase()}/`, limit: 1000 });
    const out = await Promise.all(blobs.map((b) => readBlob(b.url).catch(() => null)));
    return out.filter((x): x is GuestRecord => !!x);
  },
};

// ------------------------------------------------------------------------------------------------ diag

const lastDiag = new Map<string, number>();

/** A server event for /api/diag (read with the scheduler secret). Never a phone number or a key. */
export async function diagEvent(kind: string, data: Record<string, unknown>, everyMs = 0): Promise<void> {
  const now = Date.now();
  if (everyMs > 0 && now - (lastDiag.get(kind) ?? 0) < everyMs) return;
  lastDiag.set(kind, now);
  const record = JSON.stringify({ at: new Date(now).toISOString(), source: "guest", kind, ...data });
  console.error("[tifo diag]", record);
  if (process.env.BLOB_READ_WRITE_TOKEN) await put(`diag/${now}-${randomBytes(4).toString("hex")}.json`, record, { access: "public", contentType: "application/json" }).catch(() => {});
}

/** Low float: logged at most every 10 minutes per server. */
export const lowFloat = (need: bigint, room: bigint) => diagEvent("naira_low_float", { need: need.toString(), room: room.toString() }, 10 * 60_000);

// ------------------------------------------------------------------------------------------------ starting a guest checkout

/** What a guest order costs: the drop's price times the quantity, plus gas, priced in naira with the charge in it. */
export function guestPrice(priceUsd: number, qty: number, cfg: Pick<NairaConfig, "rate" | "feeBps" | "feeCapKobo">, gas: bigint): { amount: bigint; total: bigint; ngn: bigint } | null {
  if (!Number.isInteger(qty) || qty < 1 || qty > 20 || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const amount = BigInt(Math.round(priceUsd * 1e6)) * BigInt(qty);
  const total = amount + gas;
  return { amount, total, ngn: priceKobo(total, cfg.rate, cfg.feeBps, cfg.feeCapKobo) };
}

export interface DropInfo {
  priceUsd: number;
  teams: [string, string];
  booking: boolean; // a bookable service needs a time picked against a wallet: not offered to guests
}

export interface StartDeps {
  drop(promo: Address): Promise<DropInfo | null>;
  precheck(promo: Address, buyer: Address, side: 0 | 1, amount: bigint, teams: [string, string]): Promise<{ error: string } | { rateBps: number }>;
  floatRoom(): Promise<bigint>;
  open(cfg: NairaConfig, body: Record<string, unknown>): Promise<{ checkoutUrl: string; checkoutId: string } | null>;
  store: GuestStore;
  diag(kind: string, data: Record<string, unknown>): Promise<void>;
  secret: string | null;
  now(): number;
}

export type GuestStarted =
  | { ok: true; checkoutUrl: string; checkoutId: string; ngn: string; rateBps: number; usd: string }
  | { ok: false; error: "disabled" | "bad_phone" | "bad_request" | "not_found" | "not_supported" | "too_large" | "busy" | "closed" | "other_side" | "provider" };

export interface StartInput {
  phone: string;
  promo: Address;
  side: 0 | 1;
  qty: number;
  referrer?: Address;
  origin: string;
}

/**
 * Opens a Bachs checkout for a guest order and writes the order down before the buyer can pay. The price comes from
 * the drop on chain, never from the browser. Refuses first if the float could not pay it out today.
 */
export async function startGuestWith(input: StartInput, cfg: NairaConfig | null, deps: StartDeps): Promise<GuestStarted> {
  if (!cfg || !deps.secret) return { ok: false, error: "disabled" };
  const phone = normalizePhone(input.phone);
  if (!phone) return { ok: false, error: "bad_phone" };
  if (!isAddress(input.promo) || (input.side !== 0 && input.side !== 1)) return { ok: false, error: "bad_request" };
  const promo = getAddress(input.promo);
  const drop = await deps.drop(promo);
  if (!drop) return { ok: false, error: "not_found" };
  if (drop.booking) return { ok: false, error: "not_supported" };
  const gas = gasUnits();
  const price = guestPrice(drop.priceUsd, input.qty, cfg, gas);
  if (!price) return { ok: false, error: "bad_request" };
  if (price.amount > BigInt(Math.floor(cfg.maxUsd * 100)) * 10_000n) return { ok: false, error: "too_large" };

  const guest = guestAddress(phone, deps.secret);
  const pre = await deps.precheck(promo, guest, input.side, price.amount, drop.teams);
  if ("error" in pre) return { ok: false, error: /closed/i.test(pre.error) ? "closed" : "other_side" };
  const room = await deps.floatRoom();
  if (room < price.total) {
    await deps.diag("naira_low_float", { need: price.total.toString(), room: room.toString() });
    return { ok: false, error: "busy" };
  }

  const referrer = input.referrer && isAddress(input.referrer) && getAddress(input.referrer) !== guest ? getAddress(input.referrer) : undefined;
  const origin = input.origin.replace(/\/$/, "");
  const opened = await deps.open(cfg, {
    pricing: { currency: "NGN", amount: formatKobo(price.ngn) },
    reference: makeGuestReference({ guest, promo, side: input.side, amount: price.amount, ngn: price.ngn }),
    success_url: `${origin}/naira/paid`, // Bachs adds ?checkout_id=
    cancel_url: `${origin}/p/${promo}`,
    payment_method_types: ["NGN_BANK_TRANSFER", "NGN_CARD"],
    expires_in_minutes: 30,
    customer_bears_fee: false,
    metadata: { promo, side: String(input.side), guest: "1" }, // never the phone number
  });
  if (!opened) return { ok: false, error: "provider" };
  const now = deps.now();
  await deps.store.put({
    v: 1,
    checkoutId: opened.checkoutId,
    promo,
    guest,
    side: input.side,
    amount: price.amount.toString(),
    gas: gas.toString(),
    ngn: price.ngn.toString(),
    rateBps: pre.rateBps,
    ...(referrer ? { referrer } : {}),
    phone: sealPhone(phone, opened.checkoutId, deps.secret),
    at: now,
    status: "started",
    updatedAt: now,
  });
  return { ok: true, ...opened, ngn: formatKobo(price.ngn), rateBps: pre.rateBps, usd: (Number(price.amount) / 1e6).toFixed(2) };
}

async function dropInfo(promo: Address): Promise<DropInfo | null> {
  const p = (await listPromos()).find((x) => x.address.toLowerCase() === promo.toLowerCase());
  if (!p) return null;
  return { priceUsd: Number(p.meta.priceUsd), teams: [p.meta.teamA, p.meta.teamB], booking: !!p.meta.slots?.length };
}

export function startGuest(input: StartInput): Promise<GuestStarted> {
  return startGuestWith(input, guestEnabled() ? nairaConfig() : null, {
    drop: dropInfo,
    precheck,
    floatRoom,
    open: openSession,
    store: blobStore,
    diag: (kind, data) => diagEvent(kind, data, kind === "naira_low_float" ? 10 * 60_000 : 0),
    secret: guestSecret(),
    now: () => Math.floor(Date.now() / 1000),
  });
}

/** A quote for the drop page: the naira price of `qty` of this drop for a guest, and whether the float can take it now. */
export async function guestQuote(promo: Address, qty: number): Promise<{ ngn: string; usd: string; busy: boolean } | null> {
  const cfg = nairaConfig();
  if (!cfg || !guestEnabled()) return null;
  const drop = await dropInfo(promo);
  if (!drop || drop.booking) return null;
  const price = guestPrice(drop.priceUsd, qty, cfg, gasUnits());
  if (!price || price.amount > BigInt(Math.floor(cfg.maxUsd * 100)) * 10_000n) return null;
  const room = await floatRoom().catch(() => 0n);
  if (room < price.total) await lowFloat(price.total, room);
  return { ngn: formatKobo(price.ngn), usd: (Number(price.amount) / 1e6).toFixed(2), busy: room < price.total };
}

/** Public drop details for the buyer's status page. Nothing private. */
export async function dropForStatus(promo: Address): Promise<{ product: string; shop: string; teams: [string, string]; digital: boolean; contact?: string } | null> {
  const p = (await listPromos()).find((x) => x.address.toLowerCase() === promo.toLowerCase());
  if (!p) return null;
  return { product: p.meta.product, shop: p.meta.shop, teams: [p.meta.teamA, p.meta.teamB], digital: !!p.meta.delivery, contact: p.meta.contact };
}

// ------------------------------------------------------------------------------------------------ completing a paid checkout

export type GuestResult =
  | { state: "pending" | "not_paid" | "float_short" }
  | { state: "done"; tx: Hex | null; record: GuestRecord }
  | { state: "offer_moved"; record: GuestRecord }
  | { state: "refund_due"; reason: string; record?: GuestRecord };

export interface BuyArgs {
  promo: Address;
  side: 0 | 1;
  amount: bigint;
  orderRef: Hex;
  minRateBps: number;
  referrer?: Address;
}

/** Everything completion touches outside this file, so it can be tested with stand ins. */
export interface GuestDeps {
  session(id: string): Promise<BachsSession | null>;
  store: GuestStore;
  floatReleased(ref: Hex): Promise<boolean>;
  floatRoom(): Promise<bigint>;
  release(ref: Hex, to: Address, amount: bigint): Promise<ReleaseResult>;
  usedRef(promo: Address, orderRef: Hex): Promise<boolean>;
  findSale(promo: Address, orderRef: Hex): Promise<Hex | null>;
  buy(key: Hex, a: BuyArgs): Promise<Hex>;
  diag(kind: string, data: Record<string, unknown>): Promise<void>;
  secret: string | null;
  now(): number;
}

// Reverts that will not change by trying again: the order cannot go through and the money stays at the buyer's address.
const FINAL = new Set(["Closed", "OneSidePerWallet", "BelowPrice", "BadSide", "OverCap"]);

export function revertName(e: unknown): string | undefined {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError && r.data?.errorName) return r.data.errorName;
  }
  return /Closed|OneSidePerWallet|BelowPrice|BadSide|OverCap|OfferGone|DuplicateOrder/.exec(e instanceof Error ? e.message : String(e))?.[0];
}

/**
 * Completes one guest checkout if and only if Bachs says it is paid. Safe to call any number of times, from the webhook
 * and from the buyer's page. `accept` is the offer (in basis points) the buyer agreed to after the shown one moved.
 */
export async function completeGuestWith(checkoutId: string, deps: GuestDeps, accept?: number): Promise<GuestResult> {
  if (!isCheckoutId(checkoutId)) return { state: "not_paid" };
  const session = await deps.session(checkoutId);
  if (!session || session.checkout_id !== checkoutId) return { state: "not_paid" };
  const ref = parseGuestReference(session.reference);
  if (!ref) return { state: "not_paid" };
  const paid = paidAgainst(session, ref.ngn);
  if (paid !== "paid") return { state: paid };

  const rec = await deps.store.get(ref.promo, checkoutId);
  if (!rec) {
    // Paid at Bachs, but this server has no order for it. Nothing was released; the naira is refunded by hand.
    await deps.diag("guest_no_record", { checkoutId });
    return { state: "refund_due", reason: "no_record" };
  }
  if (rec.guest !== ref.guest || rec.promo !== ref.promo || rec.side !== ref.side || rec.amount !== ref.amount.toString() || rec.ngn !== ref.ngn.toString()) {
    await deps.diag("guest_mismatch", { checkoutId });
    return { state: "refund_due", reason: "mismatch", record: rec };
  }
  const save = async (patch: Partial<GuestRecord>) => {
    Object.assign(rec, patch, { updatedAt: deps.now() });
    await deps.store.put(rec);
  };
  if (rec.status === "bought") return { state: "done", tx: rec.tx ?? null, record: rec };

  const orderRef = orderRefFor(checkoutId, deps.secret);
  if (await deps.usedRef(ref.promo, orderRef)) {
    // Bought before, and the record missed it (a crash between the two): find the transaction and write it down.
    const tx = rec.tx ?? (await deps.findSale(ref.promo, orderRef).catch(() => null)) ?? undefined;
    await save({ status: "bought", tx, reason: undefined });
    return { state: "done", tx: tx ?? null, record: rec };
  }
  if (rec.status === "failed") return { state: "refund_due", reason: rec.reason ?? "failed", record: rec };
  if (rec.status === "offer_moved" && accept === undefined) return { state: "offer_moved", record: rec };

  // 1. The float sends the price plus gas to the buyer's address, once per checkout.
  const floatId = floatRefFor(checkoutId);
  if (!(await deps.floatReleased(floatId))) {
    const total = ref.amount + BigInt(rec.gas);
    const room = await deps.floatRoom();
    if (room < total) {
      await deps.diag("naira_low_float", { need: total.toString(), room: room.toString(), checkoutId });
      return { state: "float_short" };
    }
    const r = await deps.release(floatId, ref.guest, total);
    if (r.state === "float_short") {
      await deps.diag("naira_low_float", { need: total.toString(), checkoutId });
      return { state: "float_short" };
    }
    if (r.state !== "released" && r.state !== "already") throw new Error(`unexpected release state ${r.state}`);
    await save({ status: "funded", fundTx: r.hash ?? rec.fundTx });
  } else if (rec.status === "started") {
    await save({ status: "funded" });
  }

  // 2. The buyer's address buys on the drop. Its key comes from the sealed phone number and must match the address.
  let key: Hex;
  try {
    key = guestKey(openPhone(rec.phone, checkoutId, deps.secret), deps.secret);
  } catch {
    key = "0x";
  }
  if (key === "0x" || privateKeyToAccount(key).address !== ref.guest) {
    await deps.diag("guest_key_mismatch", { checkoutId, guest: ref.guest });
    await save({ status: "failed", reason: "key" });
    return { state: "refund_due", reason: "key", record: rec };
  }
  const minRateBps = accept !== undefined ? Math.max(0, Math.min(10_000, Math.floor(accept))) : rec.rateBps;
  let tx: Hex;
  try {
    tx = await deps.buy(key, { promo: ref.promo, side: ref.side, amount: ref.amount, orderRef, minRateBps, referrer: rec.referrer });
  } catch (e) {
    const name = revertName(e);
    if (name === "DuplicateOrder") {
      const found = (await deps.findSale(ref.promo, orderRef).catch(() => null)) ?? undefined;
      await save({ status: "bought", tx: found });
      return { state: "done", tx: found ?? null, record: rec };
    }
    if (name === "OfferGone") {
      await save({ status: "offer_moved" });
      return { state: "offer_moved", record: rec };
    }
    if (name && FINAL.has(name)) {
      // The USDC stays at the buyer's address. Recorded so the shop or the agent can send it back.
      await save({ status: "failed", reason: name });
      await deps.diag("guest_buy_failed", { checkoutId, promo: ref.promo, guest: ref.guest, reason: name, held: (ref.amount + BigInt(rec.gas)).toString() });
      return { state: "refund_due", reason: name, record: rec };
    }
    throw e; // the network or something passing: the next check tries again, and the references keep it to one order
  }
  await save({ status: "bought", tx, reason: undefined });
  return { state: "done", tx, record: rec };
}

// ------------------------------------------------------------------------------------------------ the real chain

const saleEvent = parseAbiItem("event Sale(address indexed buyer, uint8 side, uint256 amount, uint16 rateBps, uint256 held, uint256 toSeller, bytes32 orderRef)");

async function findSale(promo: Address, orderRef: Hex): Promise<Hex | null> {
  const to = await publicClient.getBlockNumber();
  const logs = await publicClient.getLogs({ address: promo, event: saleEvent, fromBlock: to > 20_000n ? to - 20_000n : 0n, toBlock: to });
  return logs.find((l) => l.args.orderRef?.toLowerCase() === orderRef.toLowerCase())?.transactionHash ?? null;
}

// One transaction at a time per buyer address, so two checkouts of the same number never share a nonce.
const lanes = new Map<string, Promise<unknown>>();
function inLane<T>(who: string, fn: () => Promise<T>): Promise<T> {
  const run = (lanes.get(who) ?? Promise.resolve()).then(fn);
  lanes.set(who, run.catch(() => {}));
  return run;
}

async function buyAsGuest(key: Hex, a: BuyArgs): Promise<Hex> {
  const account = privateKeyToAccount(key);
  const w = createWalletClient({ account, chain, transport });
  return inLane(account.address, async () => {
    const allowance = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [account.address, a.promo] });
    if (allowance < a.amount) {
      const h = await w.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [a.promo, a.amount] });
      if ((await publicClient.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error("The approval did not go through.");
    }
    let hash: Hex;
    if (a.referrer) {
      const { request } = await publicClient.simulateContract({ account, address: a.promo, abi: tifoPromoAbi, functionName: "buyRef", args: [a.side, a.amount, a.orderRef, a.minRateBps, a.referrer] });
      hash = await w.writeContract(request);
    } else {
      const { request } = await publicClient.simulateContract({ account, address: a.promo, abi: tifoPromoAbi, functionName: "buy", args: [a.side, a.amount, a.orderRef, a.minRateBps] });
      hash = await w.writeContract(request);
    }
    if ((await publicClient.waitForTransactionReceipt({ hash })).status !== "success") throw new Error("The order transaction reverted.");
    return hash;
  });
}

export function realDeps(): GuestDeps {
  const cfg = nairaConfig();
  if (!cfg) throw new Error("Naira payments are not set up.");
  return {
    session: (id) => fetchSession(cfg, id),
    store: blobStore,
    floatReleased: (ref) => alreadyReleased(cfg, ref),
    floatRoom,
    release: releaseFloat,
    usedRef: (promo, ref) => publicClient.readContract({ address: promo, abi: tifoPromoAbi, functionName: "usedRef", args: [ref] }) as Promise<boolean>,
    findSale,
    buy: buyAsGuest,
    diag: (kind, data) => diagEvent(kind, data),
    secret: guestSecret(),
    now: () => Math.floor(Date.now() / 1000),
  };
}

// One completion per checkout at a time on this server, so a webhook and a page check landing together share one run.
const inflight = new Map<string, Promise<GuestResult>>();

export function completeGuest(checkoutId: string, accept?: number, deps?: GuestDeps): Promise<GuestResult> {
  const live = inflight.get(checkoutId);
  if (live) return live;
  const p = completeGuestWith(checkoutId, deps ?? realDeps(), accept)
    .then((r) => {
      if (r.state === "done" && !deps) void addToCustomers(r.record);
      return r;
    })
    .finally(() => inflight.delete(checkoutId));
  inflight.set(checkoutId, p);
  return p;
}

/** A paid guest becomes one of the seller's customers, so the next drop's share pack can reach them. Never blocks the order. */
async function addToCustomers(rec: GuestRecord): Promise<void> {
  try {
    const drop = (await listPromos()).find((p) => p.address.toLowerCase() === rec.promo.toLowerCase());
    if (!drop) return;
    const { mergeOrders } = await import("./customerStore");
    await mergeOrders(drop.seller, [{ phone: openPhone(rec.phone, rec.checkoutId), side: rec.side, amountUsd: Number(rec.amount) / 1e6, at: rec.at, drop: rec.promo, item: drop.meta.product }]);
  } catch {
    // the customer list is a convenience; the order already stands
  }
}

// ------------------------------------------------------------------------------------------------ for the seller and the agent

export interface GuestOrder {
  checkoutId: string;
  phone: string; // E.164; private, for the seller's own customer list only
  side: 0 | 1;
  amount: bigint; // USDC units
  ngn: bigint; // kobo paid
  tx: Hex | null;
  at: number;
  status: GuestStatus;
  guest: Address;
}

/** The guest orders on one drop, with each buyer's phone and club. Server only: never return this from a public route. */
export async function getGuestOrders(promo: Address, store: GuestStore = blobStore, secret: string | null = guestSecret()): Promise<GuestOrder[]> {
  const records = await store.list(getAddress(promo));
  const out: GuestOrder[] = [];
  for (const r of records) {
    let phone = "";
    try {
      phone = openPhone(r.phone, r.checkoutId, secret);
    } catch {
      continue; // sealed under another secret, or damaged
    }
    out.push({ checkoutId: r.checkoutId, phone, side: r.side, amount: BigInt(r.amount), ngn: BigInt(r.ngn), tx: r.tx ?? null, at: r.at, status: r.status, guest: r.guest });
  }
  return out.sort((a, b) => b.at - a.at);
}

export interface Held {
  checkoutId: string;
  guest: Address;
  status: GuestStatus;
  owed: bigint; // a refund the drop could not push and kept for the buyer to claim
  held: bigint; // USDC sitting at the buyer's address (money back, a failed order, and gas left over)
  claimTx?: Hex;
}

/**
 * For the agent: collects a refund the drop is holding for a guest (claim() from the guest's key) so it sits at the
 * guest's address with the rest of their money, and reports what is held there. Sends nothing anywhere else.
 */
export async function sweepGuest(promo: Address, checkoutId: string, store: GuestStore = blobStore, secret: string | null = guestSecret()): Promise<Held | null> {
  const rec = await store.get(getAddress(promo), checkoutId);
  if (!rec) return null;
  const owed = (await publicClient.readContract({ address: rec.promo, abi: tifoPromoAbi, functionName: "owed", args: [rec.guest] })) as bigint;
  let claimTx: Hex | undefined;
  if (owed > 0n) {
    const key = guestKey(openPhone(rec.phone, checkoutId, secret), secret);
    const account = privateKeyToAccount(key);
    if (account.address !== rec.guest) throw new Error("The guest key does not match this order.");
    const w = createWalletClient({ account, chain, transport });
    claimTx = await inLane(account.address, async () => {
      const { request } = await publicClient.simulateContract({ account, address: rec.promo, abi: tifoPromoAbi, functionName: "claim" });
      const h = await w.writeContract(request);
      if ((await publicClient.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error("The claim did not go through.");
      return h;
    });
  }
  return { checkoutId, guest: rec.guest, status: rec.status, owed, held: await usdcBalance(rec.guest), claimTx };
}

export { why };
