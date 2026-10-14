import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The three naira routes with the money movers stubbed: what matters here is which answer Bachs gets and when nothing is released.
const h = vi.hoisted(() => ({ releaseFor: vi.fn(), startCheckout: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/naira", async (orig) => ({ ...(await orig<typeof import("@/lib/naira")>()), releaseFor: h.releaseFor, startCheckout: h.startCheckout }));

import { POST as webhook } from "@/app/api/naira/webhook/route";
import { POST as check } from "@/app/api/naira/check/route";
import { GET as startInfo, POST as start } from "@/app/api/naira/start/route";

const WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const PROMO = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const ID = "chk_abc123";
const SECRET = "whsec_test";

let n = 0;
const ip = () => `10.1.${Math.floor(++n / 250)}.${n % 250}`; // a fresh caller each time, so the rate limit never gets in the way

beforeEach(() => {
  vi.stubEnv("BACHS_SECRET_KEY", "sk_sandbox_abc");
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "testnet");
  vi.stubEnv("NAIRA_PER_USD", "1550");
  vi.stubEnv("NAIRA_FLOAT", `0x${"f1".repeat(20)}`);
  vi.stubEnv("BACHS_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  h.releaseFor.mockReset();
  h.startCheckout.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

// ---------------------------------------------------------------------------------------------- webhook

describe("webhook", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const sig = (raw: string, t = now(), key = SECRET) => `t=${t},v1=${createHmac("sha256", key).update(`${t}.${raw}`).digest("hex")}`;
  const event = (type: string, data: unknown) => JSON.stringify({ id: "evt_1", type, created_at: "2026-10-14T10:00:00Z", organization_id: "acct_1", data });
  const send = (raw: string, header?: string | null) =>
    webhook(new Request("https://tifo.example/api/naira/webhook", { method: "POST", headers: { "x-forwarded-for": ip(), ...(header ? { "x-bachs-signature-v2": header } : {}) }, body: raw }));

  it("answers 401 to a bad signature and releases nothing", async () => {
    const raw = event("collection.succeeded", { checkout_id: ID });
    expect((await send(raw)).status).toBe(401); // no header
    expect((await send(raw, sig(raw, now(), "someone_else"))).status).toBe(401); // wrong secret
    expect((await send(raw, sig(raw, now() - 400))).status).toBe(401); // too old
    expect((await send(`${raw} `, sig(raw))).status).toBe(401); // body changed after signing
    expect(h.releaseFor).not.toHaveBeenCalled();
  });

  it("answers 503 when the signing secret is not set, so Bachs tries again later", async () => {
    vi.stubEnv("BACHS_WEBHOOK_SECRET", "");
    const raw = event("collection.succeeded", { checkout_id: ID });
    expect((await send(raw, sig(raw, now(), ""))).status).toBe(503);
    expect(h.releaseFor).not.toHaveBeenCalled();
  });

  it("ignores events it does not act on, with 200", async () => {
    for (const raw of [
      event("collection.failed", { checkout_id: ID }),
      event("checkout.expired", { checkout_id: ID }),
      event("refund.paid", { checkout_id: ID }),
      event("collection.succeeded", { checkout_id: null }), // a virtual account deposit
      event("collection.succeeded", {}),
      event("collection.succeeded", null),
      event("collection.succeeded", { checkout_id: "ORD-1" }),
      event("collection.succeeded", { checkout_id: "chk_../x" }),
      event("collection.succeeded", { checkout_id: 42 }),
      JSON.stringify({ id: "evt_2", data: { checkout_id: ID } }),
      "[]",
      "null",
    ]) {
      const res = await send(raw, sig(raw));
      expect(res.status, raw).toBe(200);
    }
    expect(h.releaseFor).not.toHaveBeenCalled();
  });

  it("answers 400 to a signed body that is not JSON", async () => {
    const raw = "not json";
    expect((await send(raw, sig(raw))).status).toBe(400);
  });

  it("takes only the checkout id from the event, for either of the two events", async () => {
    h.releaseFor.mockResolvedValue({ state: "released", hash: "0xabc" });
    for (const type of ["collection.succeeded", "checkout.completed"]) {
      // everything else the event claims is ignored: the amount, the status, the reference
      const raw = event(type, { checkout_id: ID, status: "SUCCEEDED", amount: "99999999.00", currency: "NGN", reference: "tifo:0x1:1:1:aaaaaaaa", payment_status: "paid" });
      const res = await send(raw, sig(raw));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state: "released" });
    }
    expect(h.releaseFor).toHaveBeenCalledTimes(2);
    for (const call of h.releaseFor.mock.calls) expect(call).toEqual([ID]);
  });

  it("answers 200 when the buyer is paid, was paid before, or the checkout was never paid", async () => {
    const raw = event("collection.succeeded", { checkout_id: ID });
    for (const state of ["released", "already", "not_paid"]) {
      h.releaseFor.mockResolvedValue({ state });
      expect((await send(raw, sig(raw))).status, state).toBe(200);
    }
  });

  it("answers 5xx when Bachs should send it again: not visible as paid yet, or the float cannot pay", async () => {
    const raw = event("collection.succeeded", { checkout_id: ID });
    for (const state of ["pending", "float_short"]) {
      h.releaseFor.mockResolvedValue({ state });
      expect((await send(raw, sig(raw))).status, state).toBe(503);
    }
  });

  it("answers 500 on a failure in between, and keeps the key out of the log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.releaseFor.mockRejectedValue(new Error("rpc down"));
    const raw = event("collection.succeeded", { checkout_id: ID });
    expect((await send(raw, sig(raw))).status).toBe(500);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("sk_sandbox_abc");
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    spy.mockRestore();
  });

  it("accepts a rotated secret: two v1 values, one of them ours", async () => {
    h.releaseFor.mockResolvedValue({ state: "already" });
    const raw = event("checkout.completed", { checkout_id: ID });
    const t = now();
    const old = sig(raw, t, "old_secret").split("v1=")[1];
    const res = await send(raw, `${sig(raw, t)},v1=${old}`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------- check

describe("check", () => {
  const ask = (body: unknown) =>
    check(new Request("https://tifo.example/api/naira/check", { method: "POST", headers: { "x-forwarded-for": ip(), "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));

  it("rejects an id that is not a Bachs checkout id", async () => {
    for (const body of [{}, { checkoutId: "" }, { checkoutId: "chk_" }, { checkoutId: "chk_a b" }, { checkoutId: "chk_a/../b" }, { checkoutId: "abc" }, { checkoutId: 5 }, { checkoutId: `${ID}\n` }, "not json"]) {
      expect((await ask(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.releaseFor).not.toHaveBeenCalled();
  });

  it("returns what releaseFor says", async () => {
    h.releaseFor.mockResolvedValue({ state: "released", hash: "0xabc" });
    const res = await ask({ checkoutId: ID });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ state: "released", hash: "0xabc" });
    expect(h.releaseFor).toHaveBeenCalledWith(ID);
    h.releaseFor.mockResolvedValue({ state: "pending" });
    expect(await (await ask({ checkoutId: ID })).json()).toEqual({ state: "pending" });
  });

  it("answers 502 when it could not find out", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.releaseFor.mockRejectedValue(new Error("Bachs answered 500"));
    expect((await ask({ checkoutId: ID })).status).toBe(502);
    spy.mockRestore();
  });

  it("answers 503 when naira payments are off", async () => {
    vi.stubEnv("NAIRA_FLOAT", "");
    expect((await ask({ checkoutId: ID })).status).toBe(503);
    expect(h.releaseFor).not.toHaveBeenCalled();
  });

  it("lets a page poll every 5 seconds for 30 minutes, then slows it", async () => {
    h.releaseFor.mockResolvedValue({ state: "pending" });
    const same = { "x-forwarded-for": "9.9.9.9", "content-type": "application/json" };
    let last = 0;
    for (let i = 0; i < 201; i++) {
      last = (await check(new Request("https://tifo.example/api/naira/check", { method: "POST", headers: same, body: JSON.stringify({ checkoutId: ID }) }))).status;
    }
    expect(last).toBe(429);
  });
});

// ---------------------------------------------------------------------------------------------- start

describe("start", () => {
  const post = (body: unknown, extra: Record<string, string> = {}, url = "https://tifo.example/api/naira/start") =>
    start(new Request(url, { method: "POST", headers: { "x-forwarded-for": ip(), "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  const ok = { wallet: WALLET, usd: 12.345, promo: PROMO };

  it("GET says whether naira payments are on, with the rate and the cap", async () => {
    const on = await startInfo(new Request("https://tifo.example/api/naira/start"));
    expect(on.headers.get("cache-control")).toBe("no-store");
    expect(await on.json()).toEqual({ enabled: true, rate: 1550, maxUsd: 50 });
    vi.stubEnv("NAIRA_MAX_USD", "20");
    expect(await (await startInfo(new Request("https://tifo.example/api/naira/start"))).json()).toMatchObject({ maxUsd: 20 });
    vi.stubEnv("BACHS_SECRET_KEY", "");
    const off = await startInfo(new Request("https://tifo.example/api/naira/start"));
    expect(await off.json()).toEqual({ enabled: false });
  });

  it("GET with ?usd= also gives the naira price, rounded up to 10 naira", async () => {
    expect(await (await startInfo(new Request("https://tifo.example/api/naira/start?usd=10"))).json()).toEqual({ enabled: true, rate: 1550, maxUsd: 50, ngn: "15500.00" });
    expect(await (await startInfo(new Request("https://tifo.example/api/naira/start?usd=12.341"))).json()).toMatchObject({ ngn: "19150.00" }); // 12.35 dollars is 19142.50 naira, up to 19150
    for (const bad of ["abc", "-4", "0", ""]) {
      expect(await (await startInfo(new Request(`https://tifo.example/api/naira/start?usd=${bad}`))).json(), bad).not.toHaveProperty("ngn");
    }
  });

  it("rejects a request that is not valid, without starting anything", async () => {
    for (const body of [{}, "nope", { ...ok, wallet: "0x123" }, { ...ok, promo: "hello" }, { ...ok, usd: "12" }, { ...ok, usd: 0.99 }, { ...ok, usd: 0 }, { ...ok, usd: -5 }, { ...ok, usd: 50.01 }, { ...ok, usd: 1e9 }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.startCheckout).not.toHaveBeenCalled();
  });

  it("accepts the edges: 1 dollar and the cap", async () => {
    h.startCheckout.mockResolvedValue({ ok: true, checkoutUrl: "https://checkout.bachs.io/c/x", checkoutId: ID, ngn: "1.00", rate: 1550 });
    expect((await post({ ...ok, usd: 1 })).status).toBe(200);
    expect((await post({ ...ok, usd: 50 })).status).toBe(200);
  });

  it("starts the checkout and gives back the page to pay on", async () => {
    h.startCheckout.mockResolvedValue({ ok: true, checkoutUrl: "https://checkout.bachs.io/c/x", checkoutId: ID, ngn: "19150.00", rate: 1550 });
    const res = await post({ ...ok, wallet: WALLET.toLowerCase() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checkoutUrl: "https://checkout.bachs.io/c/x", checkoutId: ID, ngn: "19150.00", rate: 1550 });
    expect(h.startCheckout).toHaveBeenCalledWith({ wallet: WALLET, usdUnits: 12_350_000n, promo: PROMO, origin: "https://tifo.example" });
  });

  it("sends the buyer back to the configured site address when there is one", async () => {
    h.startCheckout.mockResolvedValue({ ok: true, checkoutUrl: "https://checkout.bachs.io/c/x", checkoutId: ID, ngn: "19150.00", rate: 1550 });
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://tifo.vercel.app");
    await post(ok, { host: "evil.example" });
    expect(h.startCheckout.mock.calls[0][0].origin).toBe("https://tifo.vercel.app");
  });

  it("explains each way it can say no", async () => {
    const cases: [string, number][] = [
      ["float_short", 503],
      ["too_large", 400],
      ["bad_amount", 400],
      ["disabled", 503],
      ["provider", 502],
    ];
    for (const [error, status] of cases) {
      h.startCheckout.mockResolvedValue({ ok: false, error });
      const res = await post(ok);
      expect(res.status, error).toBe(status);
      const j = await res.json();
      expect(typeof j.error).toBe("string");
      expect(j.error).not.toMatch(/[-–—]/); // no dashes or hyphens in what the buyer reads
    }
  });

  it("says naira is paused when the float read fails, and logs without the key", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.startCheckout.mockRejectedValue(new Error("rpc down"));
    const res = await post(ok);
    expect(res.status).toBe(502);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("sk_sandbox_abc");
    spy.mockRestore();
  });

  it("answers 503 when naira payments are off", async () => {
    vi.stubEnv("NAIRA_PER_USD", "");
    expect((await post(ok)).status).toBe(503);
    expect(h.startCheckout).not.toHaveBeenCalled();
  });

  it("limits how often one caller can start a payment", async () => {
    h.startCheckout.mockResolvedValue({ ok: true, checkoutUrl: "https://checkout.bachs.io/c/x", checkoutId: ID, ngn: "1.00", rate: 1550 });
    const same = { "x-forwarded-for": "8.8.8.8" };
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await start(new Request("https://tifo.example/api/naira/start", { method: "POST", headers: { "content-type": "application/json", ...same }, body: JSON.stringify(ok) }))).status;
    }
    expect(last).toBe(429);
  });
});
