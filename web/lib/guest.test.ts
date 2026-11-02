import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// guest.ts is server only. Stand the guard down and swap the chain for stubs: every money move goes through injected deps.
vi.mock("server-only", () => ({}));
vi.mock("./chain", () => ({
  USDC: "0x3600000000000000000000000000000000000000",
  chain: { id: 5042 },
  transport: {},
  publicClient: {},
  explorerTx: (h: string) => `https://explorer/tx/${h}`,
}));

import {
  completeGuestWith,
  floatRefFor,
  getGuestOrders,
  guestAddress,
  guestEnabled,
  guestKey,
  guestPrice,
  makeGuestReference,
  normalizePhone,
  openPhone,
  orderRefFor,
  orderSecret,
  parseGuestReference,
  sealPhone,
  startGuestWith,
  type GuestDeps,
  type GuestRecord,
  type GuestStore,
  type StartDeps,
} from "./guest";
import { nairaConfig, parseReference, type BachsSession } from "./naira";

const SECRET = "s".repeat(40);
const PHONE = "+2348031234567";
const PROMO = getAddress("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
const ID = "chk_guest1";

beforeEach(() => {
  vi.stubEnv("BACHS_SECRET_KEY", "sk_sandbox_abc");
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "testnet");
  vi.stubEnv("NAIRA_PER_USD", "1550");
  vi.stubEnv("NAIRA_FLOAT", `0x${"f1".repeat(20)}`);
  vi.stubEnv("GUEST_SECRET", SECRET);
  vi.stubEnv("GUEST_GAS_USD", "");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_x");
});
afterEach(() => vi.unstubAllEnvs());

// ---------------------------------------------------------------------------------------------- phone and keys

describe("phone numbers", () => {
  it("turns the ways Nigerians type a number into one E.164 form", () => {
    for (const s of ["08031234567", "0803 123 4567", "803 123 4567", "2348031234567", "+234 803 123 4567", "+234 (0) 803-123-4567", "+2348031234567"]) {
      expect(normalizePhone(s), s).toBe(PHONE);
    }
    expect(normalizePhone("+447911123456")).toBe("+447911123456"); // another country with its +
  });
  it("refuses what is not a phone number", () => {
    for (const s of ["", "abc", "0803123456", "080312345678", "06031234567", "+234 603 123 4567", "+0123", "+1234567890123456", "0803 123 4567; drop", 8031234567, null, "1".repeat(50)]) {
      expect(normalizePhone(s as unknown), String(s)).toBeNull();
    }
  });
});

describe("guest keys", () => {
  it("is HMAC SHA256 of tifo-guest:<E.164> under the secret, the same for every way of typing the number", () => {
    const want = `0x${createHmac("sha256", SECRET).update(`tifo-guest:${PHONE}`).digest("hex")}`;
    expect(guestKey("0803 123 4567", SECRET)).toBe(want);
    expect(guestKey("+2348031234567", SECRET)).toBe(want);
    expect(guestAddress("08031234567", SECRET)).toBe(privateKeyToAccount(want as Hex).address);
  });
  it("differs by number and by secret", () => {
    expect(guestKey("08031234567", SECRET)).not.toBe(guestKey("08031234568", SECRET));
    expect(guestKey("08031234567", SECRET)).not.toBe(guestKey("08031234567", "t".repeat(40)));
  });
  it("refuses without a secret or a real number", () => {
    expect(() => guestKey("08031234567", null)).toThrow();
    expect(() => guestKey("hello", SECRET)).toThrow();
  });
  it("needs a secret of at least 32 characters, naira settings and a store to be on", () => {
    expect(guestEnabled()).toBe(true);
    vi.stubEnv("GUEST_SECRET", "short");
    expect(guestEnabled()).toBe(false);
    vi.stubEnv("GUEST_SECRET", SECRET);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    expect(guestEnabled()).toBe(false);
  });
  it("seals the phone number to its checkout", () => {
    const sealed = sealPhone(PHONE, ID, SECRET);
    expect(sealed).not.toContain("803");
    expect(openPhone(sealed, ID, SECRET)).toBe(PHONE);
    expect(() => openPhone(sealed, "chk_other", SECRET)).toThrow();
    expect(() => openPhone(sealed, ID, "t".repeat(40))).toThrow();
  });
  it("gives each checkout its own order secret, whose hash is the on chain reference", () => {
    expect(orderSecret(ID, SECRET)).not.toBe(orderSecret("chk_guest2", SECRET));
    expect(orderRefFor(ID, SECRET)).toBe(keccak256(orderSecret(ID, SECRET)));
    expect(floatRefFor(ID)).toBe(keccak256(toBytes(ID))); // the same float key the wallet top up uses: one release per checkout
  });
});

// ---------------------------------------------------------------------------------------------- reference

describe("guest reference", () => {
  const guest = guestAddress(PHONE, SECRET);
  const base = { guest, promo: PROMO, side: 1 as const, amount: 12_000_000n, ngn: 1_900_000n };

  it("round trips, and stays within 128 characters", () => {
    const ref = makeGuestReference(base);
    expect(ref.length).toBeLessThanOrEqual(128);
    expect(parseGuestReference(ref)).toMatchObject(base);
  });
  it("never reads as a wallet top up reference, and the other way round", () => {
    const ref = makeGuestReference(base);
    expect(parseReference(ref)).toBeNull();
    expect(parseGuestReference(`tifo:${guest.toLowerCase()}:1000000:155000:aaaaaaaa`)).toBeNull();
  });
  it("refuses anything that is not exactly the form", () => {
    const good = makeGuestReference(base);
    for (const bad of [
      good.replace(":1:", ":2:"),
      good.replace("tg:", "TG:"),
      `${good}x`,
      good.replace(/:[0-9a-f]{8}$/, ":zzzzzzzz"),
      good.replace(":12000000:", ":0:"),
      good.replace(":12000000:", ":-5:"),
      good.replace(guest.slice(2).toLowerCase(), guest.slice(2)), // capitals
      42,
      null,
      "x".repeat(200),
    ]) {
      expect(parseGuestReference(bad), String(bad)).toBeNull();
    }
    expect(() => makeGuestReference({ ...base, amount: 0n })).toThrow();
    expect(() => makeGuestReference({ ...base, promo: "0x12" as Address })).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------- store and deps

function memStore(): GuestStore & { rows: Map<string, GuestRecord> } {
  const rows = new Map<string, GuestRecord>();
  return {
    rows,
    get: async (_p, id) => (rows.has(id) ? structuredClone(rows.get(id)!) : null),
    put: async (r) => void rows.set(r.checkoutId, structuredClone(r)),
    list: async (p) => [...rows.values()].filter((r) => r.promo === p).map((r) => structuredClone(r)),
  };
}

const GUEST = guestAddress(PHONE, SECRET);
const AMOUNT = 12_000_000n;
const NGN = 1_900_000n;
const TX = `0x${"cd".repeat(32)}` as Hex;

function record(over: Partial<GuestRecord> = {}): GuestRecord {
  return { v: 1, checkoutId: ID, promo: PROMO, guest: GUEST, side: 1, amount: AMOUNT.toString(), gas: "50000", ngn: NGN.toString(), rateBps: 5000, phone: sealPhone(PHONE, ID, SECRET), at: 1, status: "started", updatedAt: 1, ...over };
}

function paidSession(over: Partial<BachsSession> = {}): BachsSession {
  return {
    checkout_id: ID,
    status: "completed",
    currency: "NGN",
    reference: makeGuestReference({ guest: GUEST, promo: PROMO, side: 1, amount: AMOUNT, ngn: NGN }),
    charge: { status: "succeeded", amount: "19000.00", amount_paid: "19000.00", currency: "NGN" },
    ...over,
  };
}

function deps(over: Partial<Omit<GuestDeps, "store">> = {}) {
  const store = memStore();
  store.rows.set(ID, record());
  const state = { released: false, used: false };
  const d: GuestDeps & { store: typeof store; state: typeof state } = {
    session: vi.fn(async () => paidSession()),
    store,
    state,
    floatReleased: vi.fn(async () => state.released),
    floatRoom: vi.fn(async () => 50_000_000n),
    release: vi.fn(async () => {
      state.released = true;
      return { state: "released" as const, hash: `0x${"aa".repeat(32)}` as Hex };
    }),
    usedRef: vi.fn(async () => state.used),
    findSale: vi.fn(async () => TX),
    buy: vi.fn(async () => {
      state.used = true;
      return TX;
    }),
    diag: vi.fn(async () => {}),
    secret: SECRET,
    now: () => 100,
    ...over,
  };
  return d;
}

// ---------------------------------------------------------------------------------------------- completion

describe("completing a guest checkout", () => {
  it("releases price plus gas to the guest address, buys from the guest key, and records it", async () => {
    const d = deps();
    const r = await completeGuestWith(ID, d);
    expect(r.state).toBe("done");
    expect(d.release).toHaveBeenCalledWith(floatRefFor(ID), GUEST, AMOUNT + 50_000n);
    expect(d.buy).toHaveBeenCalledTimes(1);
    const [key, args] = (d.buy as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(privateKeyToAccount(key).address).toBe(GUEST);
    expect(args).toEqual({ promo: PROMO, side: 1, amount: AMOUNT, orderRef: orderRefFor(ID, SECRET), minRateBps: 5000, referrer: undefined });
    expect(d.store.rows.get(ID)).toMatchObject({ status: "bought", tx: TX });
  });

  it("completes exactly once however often it is called", async () => {
    const d = deps();
    for (let i = 0; i < 4; i++) expect((await completeGuestWith(ID, d)).state).toBe("done");
    expect(d.release).toHaveBeenCalledTimes(1);
    expect(d.buy).toHaveBeenCalledTimes(1);
  });

  it("never releases twice: an earlier release is not repeated, and a record that missed the buy finds it on chain", async () => {
    const d = deps();
    d.state.released = true;
    d.state.used = true; // bought, but the record still says started (a crash between the two)
    const r = await completeGuestWith(ID, d);
    expect(r).toMatchObject({ state: "done", tx: TX });
    expect(d.release).not.toHaveBeenCalled();
    expect(d.buy).not.toHaveBeenCalled();
    expect(d.store.rows.get(ID)?.status).toBe("bought");
  });

  it("moves nothing until Bachs says it is paid, and asks Bachs rather than trusting anyone", async () => {
    for (const [s, want] of [
      [paidSession({ status: "open", charge: null }), "pending"],
      [paidSession({ charge: { status: "underpaid", amount_paid: "100.00", currency: "NGN" } }), "not_paid"],
      [paidSession({ charge: { status: "succeeded", amount_paid: "18999.99", currency: "NGN" } }), "not_paid"],
      [paidSession({ charge: { status: "succeeded", amount_paid: "19000.00", currency: "USD" } }), "not_paid"],
      [paidSession({ checkout_id: "chk_other" }), "not_paid"],
      [paidSession({ reference: "tifo:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed:1000000:1550000:aaaaaaaa" }), "not_paid"], // a wallet top up
      [null, "not_paid"],
    ] as const) {
      const d = deps({ session: vi.fn(async () => s as BachsSession | null) });
      expect((await completeGuestWith(ID, d)).state, JSON.stringify(s)).toBe(want);
      expect(d.release).not.toHaveBeenCalled();
      expect(d.buy).not.toHaveBeenCalled();
    }
    expect((await completeGuestWith("not-a-checkout", deps())).state).toBe("not_paid");
  });

  it("waits, without buying, when the float cannot pay, and logs it", async () => {
    const d = deps({ floatRoom: vi.fn(async () => 1_000_000n) });
    expect((await completeGuestWith(ID, d)).state).toBe("float_short");
    expect(d.release).not.toHaveBeenCalled();
    expect(d.buy).not.toHaveBeenCalled();
    expect(d.diag).toHaveBeenCalledWith("naira_low_float", expect.objectContaining({ checkoutId: ID }));
    const d2 = deps({ release: vi.fn(async () => ({ state: "float_short" as const })) });
    expect((await completeGuestWith(ID, d2)).state).toBe("float_short");
    expect(d2.buy).not.toHaveBeenCalled();
  });

  it("keeps the money at the guest address and records it when the drop has closed", async () => {
    const d = deps({ buy: vi.fn(async () => Promise.reject(new Error('The contract function "buy" reverted. Error: Closed()'))) });
    const r = await completeGuestWith(ID, d);
    expect(r).toMatchObject({ state: "refund_due", reason: "Closed" });
    expect(d.store.rows.get(ID)).toMatchObject({ status: "failed", reason: "Closed" });
    expect(d.diag).toHaveBeenCalledWith("guest_buy_failed", expect.objectContaining({ checkoutId: ID, reason: "Closed" }));
    expect(JSON.stringify((d.diag as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("803"); // no phone number in the log
    // and it does not try again
    expect((await completeGuestWith(ID, d)).state).toBe("refund_due");
    expect(d.buy).toHaveBeenCalledTimes(1);
    expect(d.release).toHaveBeenCalledTimes(1);
  });

  it("asks the buyer when the offer moved, then buys at the offer they took", async () => {
    let first = true;
    const d = deps();
    d.buy = vi.fn(async () => {
      if (first) {
        first = false;
        throw new Error("reverted: OfferGone()");
      }
      d.state.used = true;
      return TX;
    });
    expect((await completeGuestWith(ID, d)).state).toBe("offer_moved");
    expect((await completeGuestWith(ID, d)).state).toBe("offer_moved"); // waits for the buyer
    expect(d.buy).toHaveBeenCalledTimes(1);
    expect((await completeGuestWith(ID, d, 2500)).state).toBe("done");
    expect((d.buy as ReturnType<typeof vi.fn>).mock.calls[1][1].minRateBps).toBe(2500);
    expect(d.release).toHaveBeenCalledTimes(1);
  });

  it("treats a duplicate order as done", async () => {
    const d = deps({ buy: vi.fn(async () => Promise.reject(new Error("DuplicateOrder()"))) });
    expect(await completeGuestWith(ID, d)).toMatchObject({ state: "done", tx: TX });
  });

  it("throws on a passing failure, so the next check tries again, with the money already at the guest address", async () => {
    const d = deps({ buy: vi.fn(async () => Promise.reject(new Error("rpc timeout"))) });
    await expect(completeGuestWith(ID, d)).rejects.toThrow("rpc timeout");
    expect(d.store.rows.get(ID)?.status).toBe("funded");
    d.buy = vi.fn(async () => TX);
    expect((await completeGuestWith(ID, d)).state).toBe("done");
    expect(d.release).toHaveBeenCalledTimes(1);
  });

  it("refuses when the record is missing or does not match the reference, without moving money", async () => {
    const d = deps();
    d.store.rows.clear();
    expect(await completeGuestWith(ID, d)).toMatchObject({ state: "refund_due", reason: "no_record" });
    const d2 = deps();
    d2.store.rows.set(ID, record({ amount: "1" }));
    expect(await completeGuestWith(ID, d2)).toMatchObject({ state: "refund_due", reason: "mismatch" });
    const d3 = deps({ secret: "t".repeat(40) }); // the secret changed: the key no longer opens
    expect(await completeGuestWith(ID, d3)).toMatchObject({ state: "refund_due" });
    for (const x of [d, d2, d3]) expect(x.buy).not.toHaveBeenCalled();
    expect(d.release).not.toHaveBeenCalled();
    expect(d2.release).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------- start

describe("starting a guest checkout", () => {
  const cfg = () => nairaConfig()!;
  function sdeps(over: Partial<Omit<StartDeps, "store">> = {}) {
    const store = memStore();
    const d: StartDeps & { store: typeof store } = {
      drop: vi.fn(async () => ({ priceUsd: 6, teams: ["Arsenal", "Chelsea"] as [string, string], booking: false })),
      precheck: vi.fn(async () => ({ rateBps: 5000 })),
      floatRoom: vi.fn(async () => 50_000_000n),
      open: vi.fn(async () => ({ checkoutUrl: "https://checkout.bachs.io/c/x", checkoutId: ID })),
      store,
      diag: vi.fn(async () => {}),
      secret: SECRET,
      now: () => 100,
      ...over,
    };
    return d;
  }
  const input = { phone: "0803 123 4567", promo: PROMO, side: 1 as const, qty: 2, origin: "https://tifo.example/" };

  it("prices from the drop, binds the reference, and writes the order down with the phone sealed", async () => {
    const d = sdeps();
    const r = await startGuestWith(input, cfg(), d);
    const price = guestPrice(6, 2, cfg(), 50_000n)!;
    expect(r).toEqual({ ok: true, checkoutUrl: "https://checkout.bachs.io/c/x", checkoutId: ID, ngn: `${price.ngn / 100n}.00`, rateBps: 5000, usd: "12.00" });
    const body = (d.open as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(parseGuestReference(body.reference)).toMatchObject({ guest: GUEST, promo: PROMO, side: 1, amount: 12_000_000n, ngn: price.ngn });
    expect(body.success_url).toBe("https://tifo.example/naira/paid");
    expect(JSON.stringify(body)).not.toContain("803"); // the phone never goes to Bachs
    const rec = d.store.rows.get(ID)!;
    expect(rec).toMatchObject({ guest: GUEST, side: 1, amount: "12000000", gas: "50000", status: "started", rateBps: 5000 });
    expect(rec.phone).not.toContain("803");
    expect(openPhone(rec.phone, ID, SECRET)).toBe(PHONE);
  });

  it("charges the gas in the naira price", () => {
    const c = cfg();
    expect(guestPrice(6, 2, c, 50_000n)!.ngn).toBeGreaterThanOrEqual(guestPrice(6, 2, c, 0n)!.ngn);
    expect(guestPrice(6, 0, c, 0n)).toBeNull();
    expect(guestPrice(6, 21, c, 0n)).toBeNull();
  });

  it("says busy, and logs it, when the float cannot cover the order, without opening a checkout", async () => {
    const d = sdeps({ floatRoom: vi.fn(async () => 1_000_000n) });
    expect(await startGuestWith(input, cfg(), d)).toEqual({ ok: false, error: "busy" });
    expect(d.open).not.toHaveBeenCalled();
    expect(d.diag).toHaveBeenCalledWith("naira_low_float", expect.anything());
  });

  it("explains each refusal without opening a checkout", async () => {
    const cases: [Partial<Omit<StartDeps, "store">>, Partial<typeof input>, string][] = [
      [{}, { phone: "123" }, "bad_phone"],
      [{ drop: vi.fn(async () => null) }, {}, "not_found"],
      [{ drop: vi.fn(async () => ({ priceUsd: 6, teams: ["A", "B"] as [string, string], booking: true })) }, {}, "not_supported"],
      [{ drop: vi.fn(async () => ({ priceUsd: 40, teams: ["A", "B"] as [string, string], booking: false })) }, {}, "too_large"],
      [{ precheck: vi.fn(async () => ({ error: "This promo closed at kickoff." })) }, {}, "closed"],
      [{ precheck: vi.fn(async () => ({ error: "This wallet already took the A offer" })) }, {}, "other_side"],
      [{ open: vi.fn(async () => null) }, {}, "provider"],
    ];
    for (const [over, inp, want] of cases) {
      const d = sdeps(over);
      expect(await startGuestWith({ ...input, ...inp }, cfg(), d), want).toEqual({ ok: false, error: want });
      if (want !== "provider") expect(d.open, want).not.toHaveBeenCalled();
      expect(d.store.rows.size, want).toBe(0);
    }
    expect(await startGuestWith(input, null, sdeps())).toEqual({ ok: false, error: "disabled" });
    expect(await startGuestWith(input, cfg(), sdeps({ secret: null }))).toEqual({ ok: false, error: "disabled" });
  });

  it("keeps a referrer, but not the buyer's own address", async () => {
    const ref = getAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    const d = sdeps();
    await startGuestWith({ ...input, referrer: ref }, cfg(), d);
    expect(d.store.rows.get(ID)?.referrer).toBe(ref);
    const d2 = sdeps();
    await startGuestWith({ ...input, referrer: GUEST }, cfg(), d2);
    expect(d2.store.rows.get(ID)?.referrer).toBeUndefined();
  });
});

describe("guest orders for the seller", () => {
  it("lists phone, club, amount and receipt, newest first, skipping what it cannot open", async () => {
    const s = memStore();
    s.rows.set(ID, record({ status: "bought", tx: TX, at: 5 }));
    s.rows.set("chk_b", { ...record({ checkoutId: "chk_b", at: 9, side: 0 }), phone: sealPhone("+2348099999999", "chk_b", SECRET) });
    s.rows.set("chk_c", { ...record({ checkoutId: "chk_c" }), phone: sealPhone(PHONE, "chk_c", "t".repeat(40)) });
    const out = await getGuestOrders(PROMO, s, SECRET);
    expect(out.map((o) => [o.checkoutId, o.phone, o.side])).toEqual([
      ["chk_b", "+2348099999999", 0],
      [ID, PHONE, 1],
    ]);
    expect(out[1]).toMatchObject({ amount: AMOUNT, tx: TX, status: "bought" });
  });
});
