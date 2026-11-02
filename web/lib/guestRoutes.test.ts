import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The guest routes with the money movers stubbed: what matters is what the browser and Bachs get back, and that a
// phone number never comes out of a public answer.
const h = vi.hoisted(() => ({ startGuest: vi.fn(), completeGuest: vi.fn(), guestQuote: vi.fn(), dropForStatus: vi.fn(), sweepGuest: vi.fn(), releaseFor: vi.fn(), payoutEvent: vi.fn(), collectMoneyBack: vi.fn(), setAccount: vi.fn(), payoutStatus: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/guest", async (orig) => ({ ...(await orig<typeof import("@/lib/guest")>()), ...h, lowFloat: vi.fn(async () => {}) }));
vi.mock("@/lib/guestPayout", async (orig) => ({ ...(await orig<typeof import("@/lib/guestPayout")>()), payoutEvent: h.payoutEvent, collectMoneyBack: h.collectMoneyBack, setAccount: h.setAccount, payoutStatus: h.payoutStatus }));
vi.mock("@/lib/naira", async (orig) => ({ ...(await orig<typeof import("@/lib/naira")>()), releaseFor: h.releaseFor }));

import { GET as quote, POST as start } from "@/app/api/naira/guest/start/route";
import { POST as check } from "@/app/api/naira/guest/check/route";
import { POST as claim } from "@/app/api/naira/guest/claim/route";
import { POST as webhook } from "@/app/api/naira/webhook/route";
import { POST as payout } from "@/app/api/naira/guest/payout/route";

const PROMO = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const GUEST = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const ID = "chk_guest1";
const TX = `0x${"cd".repeat(32)}`;
const WHSEC = "whsec_test";

let n = 0;
const ip = () => `10.2.${Math.floor(++n / 250)}.${n % 250}`;
const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "x-forwarded-for": ip(), "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("BACHS_SECRET_KEY", "sk_sandbox_abc");
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "testnet");
  vi.stubEnv("NAIRA_PER_USD", "1550");
  vi.stubEnv("NAIRA_FLOAT", `0x${"f1".repeat(20)}`);
  vi.stubEnv("BACHS_WEBHOOK_SECRET", WHSEC);
  vi.stubEnv("GUEST_SECRET", "s".repeat(40));
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_x");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  vi.stubEnv("TICK_SECRET", "tick");
  for (const f of Object.values(h)) f.mockReset();
  h.dropForStatus.mockResolvedValue({ product: "Jersey", shop: "Ada", teams: ["Arsenal", "Chelsea"], digital: false });
});
afterEach(() => vi.unstubAllEnvs());

describe("guest start", () => {
  const ok = { phone: "08031234567", promo: PROMO, side: 1, qty: 1 };

  it("GET says whether it is on, and quotes an order", async () => {
    expect(await (await quote(new Request("https://t.example/api/naira/guest/start"))).json()).toEqual({ enabled: true });
    h.guestQuote.mockResolvedValue({ ngn: "9460.00", usd: "6.00", busy: false });
    expect(await (await quote(new Request(`https://t.example/api/naira/guest/start?promo=${PROMO}&qty=1`))).json()).toEqual({ enabled: true, ngn: "9460.00", usd: "6.00", busy: false });
    vi.stubEnv("GUEST_SECRET", "");
    expect(await (await quote(new Request("https://t.example/api/naira/guest/start"))).json()).toEqual({ enabled: false });
  });

  it("GET stays on as busy when the quote fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.guestQuote.mockRejectedValue(new Error("rpc down"));
    expect(await (await quote(new Request(`https://t.example/api/naira/guest/start?promo=${PROMO}&qty=1`))).json()).toEqual({ enabled: true, busy: true });
    spy.mockRestore();
  });

  it("rejects a bad request without starting anything", async () => {
    for (const body of [{}, "nope", { ...ok, promo: "x" }, { ...ok, side: 2 }, { ...ok, qty: 0 }, { ...ok, qty: 21 }, { ...ok, qty: 1.5 }, { ...ok, phone: 8031234567 }, { ...ok, referrer: "x" }]) {
      expect((await start(json("https://t.example/api/naira/guest/start", body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.startGuest).not.toHaveBeenCalled();
  });

  it("starts the checkout with the site address", async () => {
    h.startGuest.mockResolvedValue({ ok: true, checkoutUrl: "https://checkout.bachs.io/c/x", checkoutId: ID, ngn: "9460.00", rateBps: 5000, usd: "6.00" });
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://tifo.vercel.app");
    const res = await start(json("https://t.example/api/naira/guest/start", ok, { host: "evil.example" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checkoutUrl: "https://checkout.bachs.io/c/x", checkoutId: ID, ngn: "9460.00", rateBps: 5000, usd: "6.00" });
    expect(h.startGuest.mock.calls[0][0]).toMatchObject({ phone: "08031234567", side: 1, qty: 1, origin: "https://tifo.vercel.app" });
  });

  it("explains each refusal in plain words with no dashes or betting words", async () => {
    for (const error of ["disabled", "bad_phone", "bad_request", "not_found", "not_supported", "too_large", "busy", "closed", "other_side", "provider"]) {
      h.startGuest.mockResolvedValue({ ok: false, error });
      const res = await start(json("https://t.example/api/naira/guest/start", ok));
      expect(res.status, error).toBeGreaterThanOrEqual(400);
      const j = await res.json();
      expect(j.code).toBe(error);
      expect(j.error).not.toMatch(/[-–—]|\bbet|odds|stake|wager/i);
    }
    h.startGuest.mockResolvedValue({ ok: false, error: "busy" });
    const busy = await start(json("https://t.example/api/naira/guest/start", ok));
    expect(busy.status).toBe(503);
    expect((await busy.json()).error).toBe("Naira checkout is busy. Try again in a few minutes.");
  });
});

describe("guest check", () => {
  const record = { promo: PROMO, guest: GUEST, side: 1, amount: "6000000", rateBps: 5000, phone: "g1.sealed", checkoutId: ID };

  it("rejects an id that is not a checkout id", async () => {
    for (const body of [{}, { checkoutId: "abc" }, { checkoutId: ID, accept: 20_000 }, { checkoutId: ID, accept: -1 }]) {
      expect((await check(json("https://t.example/api/naira/guest/check", body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.completeGuest).not.toHaveBeenCalled();
  });

  it("says the order is in, with the receipt and the order secret, and never the phone", async () => {
    h.completeGuest.mockResolvedValue({ state: "done", tx: TX, record });
    const res = await check(json("https://t.example/api/naira/guest/check", { checkoutId: ID }));
    const j = await res.json();
    expect(j).toMatchObject({ state: "done", tx: TX, order: { promo: PROMO, side: 1, amount: "6000000", rateBps: 5000, guest: GUEST }, drop: { product: "Jersey" } });
    expect(j.txUrl).toContain(TX);
    expect(j.secret).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.stringify(j)).not.toContain("g1.");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("passes the offer the buyer took, and gives no secret before the order is in", async () => {
    h.completeGuest.mockResolvedValue({ state: "offer_moved", record });
    const j = await (await check(json("https://t.example/api/naira/guest/check", { checkoutId: ID, accept: 2500 }))).json();
    expect(h.completeGuest).toHaveBeenCalledWith(ID, 2500);
    expect(j.state).toBe("offer_moved");
    expect(j).not.toHaveProperty("secret");
    h.completeGuest.mockResolvedValue({ state: "pending" });
    expect(await (await check(json("https://t.example/api/naira/guest/check", { checkoutId: ID }))).json()).toEqual({ state: "pending" });
  });

  it("answers 502 when it could not find out", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.completeGuest.mockRejectedValue(new Error("rpc down"));
    expect((await check(json("https://t.example/api/naira/guest/check", { checkoutId: ID }))).status).toBe(502);
    spy.mockRestore();
  });
});

describe("webhook for a guest checkout", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({ id: "evt_1", type: "collection.succeeded", data: { checkout_id: ID } });
  const sig = (t = now()) => `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${raw}`).digest("hex")}`;
  const send = () => webhook(new Request("https://t.example/api/naira/webhook", { method: "POST", headers: { "x-forwarded-for": ip(), "x-bachs-signature-v2": sig() }, body: raw }));

  it("completes the guest order when it is not a wallet top up", async () => {
    h.releaseFor.mockResolvedValue({ state: "not_paid" });
    h.completeGuest.mockResolvedValue({ state: "done", tx: TX, record: {} });
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "done" });
    expect(h.completeGuest).toHaveBeenCalledWith(ID);
  });

  it("asks Bachs to send it again while the guest order is waiting on the bank or the float", async () => {
    h.releaseFor.mockResolvedValue({ state: "not_paid" });
    for (const state of ["pending", "float_short"]) {
      h.completeGuest.mockResolvedValue({ state });
      expect((await send()).status, state).toBe(503);
    }
    for (const state of ["refund_due", "offer_moved", "not_paid"]) {
      h.completeGuest.mockResolvedValue({ state, reason: "Closed", record: {} });
      expect((await send()).status, state).toBe(200);
    }
  });

  it("does not look for a guest order when the top up was handled, or guests are off", async () => {
    h.releaseFor.mockResolvedValue({ state: "released" });
    await send();
    vi.stubEnv("GUEST_SECRET", "");
    h.releaseFor.mockResolvedValue({ state: "not_paid" });
    await send();
    expect(h.completeGuest).not.toHaveBeenCalled();
  });
});

describe("guest claim (agent only)", () => {
  it("needs the scheduler secret", async () => {
    expect((await claim(json("https://t.example/api/naira/guest/claim", { promo: PROMO, checkoutId: ID }))).status).toBe(401);
    expect((await claim(json("https://t.example/api/naira/guest/claim", { promo: PROMO, checkoutId: ID }, { authorization: "Bearer nope" }))).status).toBe(401);
    expect(h.sweepGuest).not.toHaveBeenCalled();
  });

  it("collects the refund to the guest address and reports what it holds", async () => {
    h.sweepGuest.mockResolvedValue({ checkoutId: ID, guest: GUEST, status: "bought", owed: 3_000_000n, held: 3_040_000n, claimTx: TX });
    const res = await claim(json("https://t.example/api/naira/guest/claim", { promo: PROMO, checkoutId: ID }, { authorization: "Bearer tick" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checkoutId: ID, guest: GUEST, status: "bought", owed: "3000000", held: "3040000", claimTx: TX });
    h.sweepGuest.mockResolvedValue(null);
    expect((await claim(json("https://t.example/api/naira/guest/claim", { promo: PROMO, checkoutId: ID }, { authorization: "Bearer tick" }))).status).toBe(404);
  });
});

describe("money back to a bank", () => {
  const url = "https://t.example/api/naira/guest/payout";
  it("checks the request before asking anything", async () => {
    for (const body of [{}, { action: "collect", checkoutId: "x" }, { action: "account", checkoutId: ID, bankCode: "058", accountNumber: "123" }, { action: "account", checkoutId: ID, bankCode: "0/8", accountNumber: "0123456789" }, { action: "steal", checkoutId: ID }]) {
      expect((await payout(json(url, body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.setAccount).not.toHaveBeenCalled();
    expect(h.collectMoneyBack).not.toHaveBeenCalled();
  });
  it("tells the buyer their money is held when collecting is not open, and explains a wrong account", async () => {
    h.collectMoneyBack.mockResolvedValue({ error: "disabled", message: "Money back is held safely for you at your Tifo number. Collecting to your bank opens soon." });
    const r = await payout(json(url, { action: "collect", checkoutId: ID }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ can: "held_closed", message: "Money back is held safely for you at your Tifo number. Collecting to your bank opens soon." });
    h.setAccount.mockResolvedValue({ error: "bad_account", message: "We could not find that account. Check the bank and the account number." });
    const w = await payout(json(url, { action: "account", checkoutId: ID, bankCode: "058", accountNumber: "0123456789" }));
    expect(w.status).toBe(400);
    expect((await w.json()).error).not.toMatch(/[-–—]/);
    h.setAccount.mockResolvedValue({ can: "confirm", usd: "3.04", ngn: "4712", accountName: "ADA OBI", bankName: "GTBank", last4: "6789" });
    const ok = await (await payout(json(url, { action: "account", checkoutId: ID, bankCode: "058", accountNumber: "0123456789" }))).json();
    expect(JSON.stringify(ok)).not.toContain("0123456789");
  });
  it("lets a signed payout event prompt a fresh read from Bachs", async () => {
    const raw = JSON.stringify({ id: "evt_2", type: "payout.paid", data: { withdrawal_id: "pay_1", reference: "tifo-gp-chk_guest1", status: "completed" } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${raw}`).digest("hex")}`;
    h.payoutEvent.mockResolvedValue(true);
    const res = await webhook(new Request("https://t.example/api/naira/webhook", { method: "POST", headers: { "x-forwarded-for": ip(), "x-bachs-signature-v2": sig }, body: raw }));
    expect(res.status).toBe(200);
    expect(h.payoutEvent).toHaveBeenCalledWith("tifo-gp-chk_guest1");
    expect(h.releaseFor).not.toHaveBeenCalled();
  });
});
