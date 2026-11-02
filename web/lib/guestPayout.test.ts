import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";

// Collecting money back to a bank, with Bachs and the chain stood in. What matters: money moves once, the payout is
// sent once, and nothing moves for an account the bank does not know or a key without payout permission.
vi.mock("server-only", () => ({}));
vi.mock("./chain", () => ({ USDC: "0x3600000000000000000000000000000000000000", chain: { id: 5042 }, transport: {}, publicClient: {}, explorerTx: (h: string) => h }));

import { guestAddress, makeGuestReference, sealPhone, type GuestRecord, type GuestStore } from "./guest";
import { collectWith, listBanksWith, nairaFor, parsePayoutReference, payoutReference, payoutStatusWith, setAccountWith, type ChainView, type PayoutDeps } from "./guestPayout";
import type { BachsSession } from "./naira";

const SECRET = "s".repeat(40);
const PHONE = "+2348031234567";
const PROMO = getAddress("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
const ID = "chk_pay1";
const GUEST = guestAddress(PHONE, SECRET);
const TX = `0x${"ab".repeat(32)}` as Hex;

beforeEach(() => {
  vi.stubEnv("BACHS_SECRET_KEY", "sk_sandbox_abc");
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "testnet");
  vi.stubEnv("NAIRA_PER_USD", "1550");
  vi.stubEnv("NAIRA_FLOAT", `0x${"f1".repeat(20)}`);
});
afterEach(() => vi.unstubAllEnvs());

type Call = { path: string; body?: unknown; headers?: Record<string, string> };
type Reply = { status: number; json: unknown };

function setup(over: { routes?: Record<string, (c: Call) => Reply>; view?: Partial<ChainView>; record?: Partial<GuestRecord>; enabled?: boolean } = {}) {
  const rows = new Map<string, GuestRecord>();
  const store: GuestStore = {
    get: async (_p, id) => (rows.has(id) ? structuredClone(rows.get(id)!) : null),
    put: async (r) => void rows.set(r.checkoutId, structuredClone(r)),
    list: async () => [...rows.values()],
  };
  rows.set(ID, { v: 1, checkoutId: ID, promo: PROMO, guest: GUEST, side: 1, amount: "6000000", gas: "50000", ngn: "950000", rateBps: 5000, phone: sealPhone(PHONE, ID, SECRET), at: 1, status: "bought", tx: TX, updatedAt: 1, ...over.record });
  const chainState = { owed: 3_000_000n, balance: 40_000n, final: true, ...over.view };
  const calls: Call[] = [];
  const payouts: Record<string, { id: string; reference: string; status: string; failure_reason?: string }> = {};
  const routes: Record<string, (c: Call) => Reply> = {
    "POST /v1/payouts/destinations": () => ({ status: 201, json: { id: "pd_abc", status: "approved", is_usable: true, account_name: "ADA OBI", bank_name: "GTBank" } }),
    "GET /v1/payouts/destinations/pd_abc": () => ({ status: 200, json: { id: "pd_abc", status: "approved", is_usable: true } }),
    "GET /v1/payouts?reference": (c) => {
      const ref = decodeURIComponent(c.path.split("reference=")[1]);
      return { status: 200, json: { data: Object.values(payouts).filter((p) => p.reference === ref) } };
    },
    "POST /v1/payouts": (c) => {
      const b = c.body as { reference: string };
      const p = { id: `pay_${Object.keys(payouts).length + 1}`, reference: b.reference, status: "processing" };
      payouts[p.id] = p;
      return { status: 201, json: p };
    },
    "GET /v1/payouts/": (c) => {
      const id = c.path.split("/").pop()!;
      return payouts[id] ? { status: 200, json: payouts[id] } : { status: 404, json: { error_code: "NOT_FOUND" } };
    },
    "POST /v1/payouts/quotes": () => ({ status: 201, json: { quote_id: "pqt_1", to_amount: "4650.00" } }),
    "GET /v1/reference/banks?country=NG": () => ({ status: 200, json: { country: "NG", banks: [{ name: "Zenith Bank", code: "057" }, { name: "Access Bank", code: "044" }, { name: "bad", code: "../x" }] } }),
    ...over.routes,
  };
  const route = (c: Call) => {
    const m = c.body === undefined ? "GET" : "POST";
    const keys = [`${m} ${c.path}`, `${m} ${c.path.split("?")[0]}${c.path.includes("?") ? "?" + c.path.split("?")[1].split("=")[0] : ""}`, `${m} ${c.path.replace(/[^/]+$/, "")}`];
    for (const k of keys) if (routes[k]) return routes[k](c);
    throw new Error(`no route ${m} ${c.path}`);
  };
  const session: BachsSession = { checkout_id: ID, status: "completed", reference: makeGuestReference({ guest: GUEST, promo: PROMO, side: 1, amount: 6_000_000n, ngn: 950_000n }) };
  const d: PayoutDeps = {
    bachs: vi.fn(async (path: string, body?: unknown, headers?: Record<string, string>) => {
      const c = { path, body, headers };
      calls.push(c);
      return route(c);
    }),
    session: vi.fn(async () => session),
    store,
    view: vi.fn(async () => ({ ...chainState })),
    claim: vi.fn(async () => {
      chainState.balance += chainState.owed;
      chainState.owed = 0n;
      return TX;
    }),
    movable: vi.fn(async () => (chainState.balance > 10_000n ? chainState.balance - 10_000n : 0n)),
    move: vi.fn(async (_k: Hex, amount: bigint) => {
      chainState.balance -= amount;
      return TX;
    }),
    balance: vi.fn(async () => chainState.balance),
    diag: vi.fn(async () => {}),
    secret: SECRET,
    rate: 1550,
    enabled: over.enabled ?? true,
    now: () => 100,
  };
  const posts = () => calls.filter((c) => c.path === "/v1/payouts" && c.body !== undefined);
  return { d, rows, calls, posts, payouts, chainState };
}

describe("amounts and references", () => {
  it("pays whole naira at the naira rate, rounded down", () => {
    expect(nairaFor(3_030_000n, 1550)).toBe(4696n); // 4696.50
    expect(nairaFor(1n, 1550)).toBe(0n);
  });
  it("makes one reference per checkout and attempt, in the characters Bachs allows", () => {
    expect(payoutReference(ID)).toBe("tifo-gp-chk_pay1");
    expect(payoutReference(ID, 2)).toBe("tifo-gp-chk_pay1-2");
    expect(parsePayoutReference("tifo-gp-chk_pay1-2")).toEqual({ checkoutId: ID, attempt: 2 });
    expect(parsePayoutReference("tifo-gp-chk_pay1")).toEqual({ checkoutId: ID, attempt: 0 });
    for (const bad of ["other", "tifo-gp-x", "tifo-gp-chk_a/b", null]) expect(parsePayoutReference(bad)).toBeNull();
  });
  it("lists Nigerian banks by name, dropping codes that look wrong", async () => {
    const { d } = setup();
    expect(await listBanksWith(d)).toEqual([{ name: "Access Bank", code: "044" }, { name: "Zenith Bank", code: "057" }]);
  });
});

describe("collecting money back", () => {
  it("waits for the result, then offers the held amount in naira", async () => {
    const early = setup({ view: { final: false } });
    expect(await payoutStatusWith(ID, early.d)).toEqual({ can: "not_yet" });
    const { d } = setup();
    expect(await payoutStatusWith(ID, d)).toEqual({ can: "ready", usd: "3.04", ngn: "4712" });
  });

  it("sets the account, shows the resolved name, then claims, moves to the float and pays once", async () => {
    const { d, rows, posts, chainState } = setup();
    expect(await setAccountWith(ID, "058", "0123456789", d)).toMatchObject({ can: "confirm", accountName: "ADA OBI", bankName: "GTBank", last4: "6789" });
    expect(d.claim).not.toHaveBeenCalled(); // nothing moves before the buyer confirms
    const r = await collectWith(ID, d);
    expect(r).toMatchObject({ can: "sending", ngn: "4696" }); // 3.04 less 0.01 for the move's gas, at 1550
    expect(d.claim).toHaveBeenCalledTimes(1);
    expect(d.move).toHaveBeenCalledWith(expect.any(String), 3_030_000n);
    expect(chainState.balance).toBe(10_000n); // only the gas for the move is left behind
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toEqual({ destination: "pd_abc", amount: "4696.00", reference: "tifo-gp-chk_pay1", narration: "Tifo refund" });
    expect(posts()[0].headers).toEqual({ "Idempotency-Key": "tifo-gp-chk_pay1-ngn" });
    expect(rows.get(ID)?.payout).toMatchObject({ state: "sent", payoutId: "pay_1", usdc: "3030000", ngn: "4696", last4: "6789", route: "ngn" });
    expect(JSON.stringify(rows.get(ID)?.payout)).not.toContain("0123456789"); // the full account number is not kept
  });

  it("is exactly once, however often and however fast it is asked", async () => {
    const { d, posts, payouts } = setup();
    await setAccountWith(ID, "058", "0123456789", d);
    await Promise.all([collectWith(ID, d), collectWith(ID, d)]);
    await collectWith(ID, d);
    await collectWith(ID, d);
    expect(d.claim).toHaveBeenCalledTimes(1);
    expect(d.move).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(1);
    payouts.pay_1.status = "completed";
    expect(await payoutStatusWith(ID, d)).toMatchObject({ can: "paid", ngn: "4696", accountName: "ADA OBI" });
    await collectWith(ID, d);
    expect(posts()).toHaveLength(1);
  });

  it("finds a payout Bachs already has under the reference instead of sending another", async () => {
    const { d, rows, posts, payouts } = setup();
    await setAccountWith(ID, "058", "0123456789", d);
    payouts.pay_9 = { id: "pay_9", reference: "tifo-gp-chk_pay1", status: "processing" }; // sent before a crash, never written down
    await collectWith(ID, d);
    expect(posts()).toHaveLength(0);
    expect(rows.get(ID)?.payout).toMatchObject({ state: "sent", payoutId: "pay_9" });
  });

  it("does not move the money twice after a crash during the move", async () => {
    const { d, rows, chainState } = setup();
    await setAccountWith(ID, "058", "0123456789", d);
    const rec = rows.get(ID)!;
    rec.payout = { ...rec.payout!, state: "moving", usdc: "3030000", ngn: "4696", confirmed: true };
    chainState.owed = 0n;
    chainState.balance = 10_000n; // the move landed before the crash
    await collectWith(ID, d);
    expect(d.move).not.toHaveBeenCalled();
    expect(rows.get(ID)?.payout).toMatchObject({ state: "sent", ngn: "4696" });
  });

  it("falls back to a dollar quote when Bachs is short of naira", async () => {
    let first = true;
    const { d, posts, rows } = setup({
      routes: {
        "POST /v1/payouts": (c) => {
          if (first) {
            first = false;
            return { status: 400, json: { error_code: "INSUFFICIENT_BALANCE", detail: "Insufficient balance" } };
          }
          return { status: 201, json: { id: "pay_q", reference: (c.body as { reference: string }).reference, status: "pending" } };
        },
      },
    });
    await setAccountWith(ID, "058", "0123456789", d);
    await collectWith(ID, d);
    const quote = (d.bachs as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "/v1/payouts/quotes");
    expect(quote?.[1]).toEqual({ from_currency: "USD", to_currency: "NGN", amount: "3.03", payout_method: "BANK_TRANSFER" });
    expect(posts()[1].body).toEqual({ destination: "pd_abc", quote_id: "pqt_1", reference: "tifo-gp-chk_pay1", narration: "Tifo refund" });
    expect(posts()[1].body).not.toHaveProperty("amount");
    expect(posts()[1].headers).toEqual({ "Idempotency-Key": "tifo-gp-chk_pay1-usd" });
    expect(rows.get(ID)?.payout).toMatchObject({ state: "sent", payoutId: "pay_q", route: "quote" });
  });

  it("shows held, moves nothing and logs it when the key has no payout permission", async () => {
    const { d, rows } = setup({ routes: { "POST /v1/payouts/destinations": () => ({ status: 403, json: { error_code: "FORBIDDEN", detail: "This key does not have the required scope: payouts:write" } }) } });
    expect(await setAccountWith(ID, "058", "0123456789", d)).toMatchObject({ error: "disabled" });
    expect(d.diag).toHaveBeenCalledWith("guest_payout_not_permitted", expect.objectContaining({ step: "destination", status: 403 }));
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.move).not.toHaveBeenCalled();
    expect(rows.get(ID)?.payout).toBeUndefined();
  });

  it("keeps the money held in the float when the payout itself is not permitted, and sends nothing", async () => {
    const { d, posts, rows } = setup({ routes: { "GET /v1/payouts?reference": () => ({ status: 403, json: { error_code: "FORBIDDEN" } }) } });
    await setAccountWith(ID, "058", "0123456789", d);
    expect(await collectWith(ID, d)).toMatchObject({ error: "disabled" });
    expect(posts()).toHaveLength(0);
    expect(rows.get(ID)?.payout).toMatchObject({ state: "moved", usdc: "3030000" }); // recorded, owed in naira, picked up when allowed
  });

  it("shows held when payouts are switched off", async () => {
    const { d } = setup({ enabled: false });
    expect(await payoutStatusWith(ID, d)).toEqual({ can: "held", usd: "3.04", ngn: "4712" });
    expect(await setAccountWith(ID, "058", "0123456789", d)).toMatchObject({ error: "disabled" });
    expect(await collectWith(ID, d)).toMatchObject({ error: "disabled" });
  });

  it("refuses a wrong account without moving money", async () => {
    for (const reply of [
      { status: 400, json: { error_code: "BANK_ROUTING_DETAILS_INVALID" } },
      { status: 201, json: { id: "pd_x", status: "pending_review", account_name: null } }, // the bank could not name it
      { status: 201, json: { id: "pd_x", status: "rejected", account_name: "X" } },
    ]) {
      const { d, rows } = setup({ routes: { "POST /v1/payouts/destinations": () => reply } });
      expect(await setAccountWith(ID, "058", "0123456789", d), JSON.stringify(reply)).toMatchObject({ error: "bad_account" });
      expect(rows.get(ID)?.payout).toBeUndefined();
    }
    const { d } = setup();
    for (const [bank, acct] of [["058", "123"], ["058", "01234567890"], ["", "0123456789"], ["0/8", "0123456789"]]) {
      expect(await setAccountWith(ID, bank, acct, d)).toMatchObject({ error: "bad_account" });
    }
    expect(d.bachs).not.toHaveBeenCalled();
  });

  it("waits for the bank to approve a new account before moving anything", async () => {
    let usable = false;
    const { d, posts } = setup({ routes: { "GET /v1/payouts/destinations/pd_abc": () => ({ status: 200, json: { status: usable ? "approved" : "pending_review", is_usable: usable } }) } });
    await setAccountWith(ID, "058", "0123456789", d);
    expect(await collectWith(ID, d)).toMatchObject({ can: "waiting_bank" });
    expect(d.move).not.toHaveBeenCalled();
    usable = true;
    expect(await collectWith(ID, d)).toMatchObject({ can: "sending" });
    expect(posts()).toHaveLength(1);
  });

  it("after a failed transfer, a new account gets a new reference, with the same amount and no second move", async () => {
    const { d, posts, payouts, rows } = setup();
    await setAccountWith(ID, "058", "0123456789", d);
    await collectWith(ID, d);
    payouts.pay_1.status = "failed";
    payouts.pay_1.failure_reason = "Account closed";
    expect(await payoutStatusWith(ID, d)).toMatchObject({ can: "failed", ngn: "4696" });
    expect(d.diag).toHaveBeenCalledWith("guest_payout_failed", expect.objectContaining({ checkoutId: ID }));
    expect(await setAccountWith(ID, "044", "9876543210", d)).toMatchObject({ can: "confirm", last4: "3210" });
    await collectWith(ID, d);
    expect(d.move).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(2);
    expect(posts()[1].body).toMatchObject({ amount: "4696.00", reference: "tifo-gp-chk_pay1-1" });
    expect(rows.get(ID)?.payout).toMatchObject({ state: "sent", payoutId: "pay_2", attempt: 1 });
  });

  it("collects a failed order's money at any time, before the result", async () => {
    const { d } = setup({ record: { status: "failed", reason: "Closed", tx: undefined }, view: { final: false, owed: 0n, balance: 6_050_000n } });
    expect(await payoutStatusWith(ID, d)).toMatchObject({ can: "ready", usd: "6.05" });
  });

  it("knows nothing about a checkout Bachs does not tie to this record", async () => {
    const { d } = setup();
    (d.session as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    expect(await payoutStatusWith(ID, d)).toMatchObject({ error: "not_found" });
    expect(await collectWith("bad id", d)).toMatchObject({ error: "not_found" });
  });
});
