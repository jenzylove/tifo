import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, toBytes } from "viem";

// naira.ts is server only. Under vitest the "server-only" guard would throw, so stand it down, and swap the chain for stubs.
const h = vi.hoisted(() => ({
  readContract: vi.fn(),
  simulateContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  writeContract: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./chain", () => ({
  USDC: "0x3600000000000000000000000000000000000000",
  chain: { id: 5042 },
  transport: {},
  publicClient: { readContract: h.readContract, simulateContract: h.simulateContract, waitForTransactionReceipt: h.waitForTransactionReceipt },
}));
vi.mock("viem", async (orig) => ({
  ...(await orig<typeof import("viem")>()),
  createWalletClient: () => ({ account: { address: "0x2222222222222222222222222222222222222222" }, writeContract: h.writeContract }),
}));

import {
  formatKobo,
  isPaid,
  makeReference,
  nairaConfig,
  nairaEnabled,
  parseKobo,
  parseReference,
  paymentState,
  quote,
  quoteKobo,
  priceKobo,
  releaseFor,
  startCheckout,
  usdToUnits,
  verifyWebhook,
  type BachsCharge,
  type BachsSession,
} from "./naira";

const WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // a checksummed address (EIP-55 test vector)
const FLOAT = `0x${"f1".repeat(20)}`;
const FLOAT_ADDR = getAddress(FLOAT); // the checksummed form the code holds
const PROMO = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const HASH = `0x${"ab".repeat(32)}`;

// ---------------------------------------------------------------------------------------------- quote

describe("quote", () => {
  it("prices dollars in naira, rounded up to the next 10 naira", () => {
    expect(quote(10_000_000n, 1550)).toBe("15500.00"); // already a multiple of 10
    expect(quote(1_000_000n, 1553)).toBe("1560.00"); // 1553 up to 1560
    expect(quote(1_000_000n, 1550.01)).toBe("1560.00"); // one kobo over rounds up
    expect(quote(2_500_000n, 1551)).toBe("3880.00"); // 3877.50 up to 3880
    expect(quote(1n, 1550)).toBe("10.00"); // never below one step
  });

  it("rounds a part kobo up before rounding to 10 naira, and never down", () => {
    // 3.333333 USDC at 1500 is 4999.9995 naira
    expect(quoteKobo(3_333_333n, 1500)).toBe(500_000n);
    expect(quote(3_333_333n, 1500)).toBe("5000.00");
    // a hair over a multiple of 10 steps to the next one
    expect(quoteKobo(1_000_001n, 1500)).toBe(151_000n);
  });

  it("builds the payment charge into the price, grossed up and capped", () => {
    // After Bachs takes 1.5% of what the buyer paid, at least the naira for the USDC is left.
    for (const usd of [1n, 2n, 4n, 10n, 25n, 50n]) {
      const base = quoteKobo(usd * 1_000_000n, 1500);
      const price = priceKobo(usd * 1_000_000n, 1500, 150, 200_000n);
      expect(price - (price * 150n) / 10_000n, String(usd)).toBeGreaterThanOrEqual(base);
      expect(price % 1000n).toBe(0n); // a round 10 naira
    }
    expect(formatKobo(priceKobo(2_000_000n, 1500, 150, 200_000n))).toBe("3050.00"); // 3000 naira plus 45.69, up to 3050
    expect(formatKobo(priceKobo(4_000_000n, 1500, 150, 200_000n))).toBe("6100.00"); // 6000 plus 91.37
    // The charge never goes past the cap (2,000 naira): 1,000 dollars at 1,500 is 1.5m naira.
    expect(priceKobo(1_000_000_000n, 1500, 150, 200_000n)).toBe(150_000_000n + 200_000n);
    expect(priceKobo(10_000_000n, 1500, 0, 200_000n)).toBe(quoteKobo(10_000_000n, 1500)); // no charge, no change
  });

  it("works from whole numbers, so a big amount is exact", () => {
    expect(quote(50_000_000n, 1612.45)).toBe("80630.00"); // 80622.50 up to 80630
    expect(quote(123_456_789_012n, 1500)).toBe("185185190.00"); // 185185183.52 up to the next 10
  });

  it("refuses an amount or a rate that makes no sense", () => {
    expect(() => quote(0n, 1500)).toThrow();
    expect(() => quote(-1n, 1500)).toThrow();
    expect(() => quote(1_000_000n, 0)).toThrow();
    expect(() => quote(1_000_000n, -5)).toThrow();
    expect(() => quote(1_000_000n, Number.NaN)).toThrow();
    expect(() => quote(1_000_000n, Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("kobo strings", () => {
  it("writes and reads Bachs amounts", () => {
    expect(formatKobo(500_000n)).toBe("5000.00");
    expect(formatKobo(5n)).toBe("0.05");
    expect(formatKobo(0n)).toBe("0.00");
    expect(parseKobo("5000.00")).toBe(500_000n);
    expect(parseKobo("5000")).toBe(500_000n);
    expect(parseKobo("5000.5")).toBe(500_050n);
    expect(parseKobo("0.01")).toBe(1n);
    expect(parseKobo("5000.000")).toBe(500_000n); // extra zeros are the same amount
  });

  it("rejects anything that is not a plain amount", () => {
    for (const bad of ["", "5,000.00", "-5", "5000.001", "5000.", ".5", "1e3", " 5000", "5000 ", "NaN", "0x10", "5000.00.00"]) expect(parseKobo(bad), bad).toBeNull();
    expect(parseKobo(5000)).toBeNull();
    expect(parseKobo(null)).toBeNull();
    expect(parseKobo(undefined)).toBeNull();
  });

  it("turns a typed dollar amount into units, rounded up to the cent", () => {
    expect(usdToUnits(12.35)).toBe(12_350_000n);
    expect(usdToUnits(12.345)).toBe(12_350_000n);
    expect(usdToUnits(12.341)).toBe(12_350_000n);
    expect(usdToUnits(9.999999)).toBe(10_000_000n);
    expect(usdToUnits(1)).toBe(1_000_000n);
    expect(usdToUnits(0)).toBeNull();
    expect(usdToUnits(-3)).toBeNull();
    expect(usdToUnits(Number.NaN)).toBeNull();
    expect(usdToUnits(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------- reference

describe("reference", () => {
  it("round trips", () => {
    const ref = makeReference({ wallet: WALLET, usdcUnits: 10_000_000n, ngn: 1_550_000n });
    expect(ref).toMatch(/^tifo:0x[0-9a-f]{40}:10000000:1550000:[0-9a-f]{8}$/);
    expect(ref.length).toBeLessThanOrEqual(128);
    const back = parseReference(ref)!;
    expect(back.wallet).toBe(WALLET); // comes back checksummed
    expect(back.usdcUnits).toBe(10_000_000n);
    expect(back.ngn).toBe(1_550_000n);
    expect(back.nonce).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is different every time", () => {
    const refs = new Set(Array.from({ length: 50 }, () => makeReference({ wallet: WALLET, usdcUnits: 1_000_000n, ngn: 150_000n })));
    expect(refs.size).toBe(50);
  });

  it("stays inside 128 characters with the biggest numbers it accepts", () => {
    const big = 10n ** 20n - 1n;
    expect(makeReference({ wallet: WALLET, usdcUnits: big, ngn: big }).length).toBeLessThanOrEqual(128);
    expect(() => makeReference({ wallet: WALLET, usdcUnits: 10n ** 20n, ngn: 1n })).toThrow(); // 21 digits is refused
  });

  it("accepts a lower case or a checksummed address", () => {
    expect(parseReference(`tifo:${WALLET.toLowerCase()}:5:7:0123abcd`)?.wallet).toBe(WALLET);
    expect(parseReference(`tifo:${WALLET}:5:7:0123abcd`)?.wallet).toBe(WALLET);
  });

  it("refuses to make a reference from bad input", () => {
    expect(() => makeReference({ wallet: "0x123", usdcUnits: 1n, ngn: 1n })).toThrow();
    expect(() => makeReference({ wallet: WALLET, usdcUnits: 0n, ngn: 1n })).toThrow();
    expect(() => makeReference({ wallet: WALLET, usdcUnits: 1n, ngn: 0n })).toThrow();
    expect(() => makeReference({ wallet: WALLET, usdcUnits: -1n, ngn: 5n })).toThrow();
  });

  it("returns null for anything that is not exactly the form", () => {
    const ok = `tifo:${WALLET.toLowerCase()}:5000000:750000:0123abcd`;
    expect(parseReference(ok)).not.toBeNull();
    const bad: unknown[] = [
      null,
      undefined,
      42,
      {},
      "",
      "tifo",
      ok.replace("tifo:", "other:"),
      ok.replace("tifo:", "Tifo:"),
      ` ${ok}`,
      `${ok} `,
      `${ok}\n`,
      `${ok}:extra`,
      ok.replace(/:0123abcd$/, ""), // no random tail
      ok.replace(/:0123abcd$/, ":0123ABCD"), // capitals in the tail
      ok.replace(/:0123abcd$/, ":0123abc"), // short tail
      ok.replace(/:0123abcd$/, ":0123abcde"), // long tail
      ok.replace(/:0123abcd$/, ":0123abcg"), // not hex
      ok.replace(WALLET.toLowerCase(), WALLET.toLowerCase().slice(0, -1)), // short address
      ok.replace(WALLET.toLowerCase(), `${WALLET.toLowerCase()}0`), // long address
      ok.replace(WALLET.toLowerCase(), WALLET.toLowerCase().replace("0x", "0X")),
      ok.replace(WALLET.toLowerCase(), `0x${"g".repeat(40)}`),
      `tifo:${WALLET.replace("5aAe", "5aae")}:5000000:750000:0123abcd`, // wrong capitals: fails the checksum
      ok.replace(":5000000:", ":-5000000:"),
      ok.replace(":5000000:", ":5000000.5:"),
      ok.replace(":5000000:", ":05000000:"), // leading zero
      ok.replace(":5000000:", ":0:"), // zero
      ok.replace(":5000000:", "::"),
      ok.replace(":5000000:", ":5e6:"),
      ok.replace(":5000000:", ":0x4c4b40:"),
      ok.replace(":750000:", ":0:"),
      ok.replace(":750000:", ":75 0000:"),
      ok.replace(":750000:", `:${"9".repeat(21)}:`), // too many digits
      `${ok}${"a".repeat(130)}`, // longer than 128
    ];
    for (const b of bad) expect(parseReference(b), String(b)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------- webhook

describe("verifyWebhook", () => {
  const secret = "whsec_test_secret";
  const now = 1_800_000_000;
  const body = JSON.stringify({ id: "evt_1", type: "collection.succeeded", data: { checkout_id: "chk_abc123" } });
  const sign = (t: number | string, raw = body, key = secret) => createHmac("sha256", key).update(`${t}.${raw}`, "utf8").digest("hex");
  const header = (t: number | string, ...sigs: string[]) => [`t=${t}`, ...sigs.map((s) => `v1=${s}`)].join(",");

  it("accepts a good signature", () => {
    expect(verifyWebhook(body, header(now, sign(now)), secret, now)).toBe(true);
  });

  it("rejects the wrong secret", () => {
    expect(verifyWebhook(body, header(now, sign(now, body, "someone_else")), secret, now)).toBe(false);
    expect(verifyWebhook(body, header(now, sign(now)), "someone_else", now)).toBe(false);
  });

  it("rejects an empty secret or a missing header", () => {
    expect(verifyWebhook(body, header(now, sign(now, body, "")), "", now)).toBe(false);
    expect(verifyWebhook(body, null, secret, now)).toBe(false);
    expect(verifyWebhook(body, undefined, secret, now)).toBe(false);
    expect(verifyWebhook(body, "", secret, now)).toBe(false);
  });

  it("rejects a body that was changed", () => {
    expect(verifyWebhook(`${body} `, header(now, sign(now)), secret, now)).toBe(false);
    expect(verifyWebhook(body.replace("chk_abc123", "chk_abc124"), header(now, sign(now)), secret, now)).toBe(false);
  });

  it("rejects a timestamp more than 300 seconds off, either way, and accepts up to 300", () => {
    expect(verifyWebhook(body, header(now - 301, sign(now - 301)), secret, now)).toBe(false);
    expect(verifyWebhook(body, header(now + 301, sign(now + 301)), secret, now)).toBe(false);
    expect(verifyWebhook(body, header(now - 300, sign(now - 300)), secret, now)).toBe(true);
    expect(verifyWebhook(body, header(now + 300, sign(now + 300)), secret, now)).toBe(true);
  });

  it("does not let the timestamp be edited without breaking the signature", () => {
    expect(verifyWebhook(body, header(now + 1, sign(now)), secret, now)).toBe(false);
  });

  it("accepts the delivery if any one of several v1 values matches", () => {
    const bad = sign(now, body, "old_secret");
    expect(verifyWebhook(body, header(now, bad, sign(now)), secret, now)).toBe(true);
    expect(verifyWebhook(body, header(now, sign(now), bad), secret, now)).toBe(true);
    expect(verifyWebhook(body, header(now, bad, bad, sign(now)), secret, now)).toBe(true);
    expect(verifyWebhook(body, header(now, bad, sign(now, body, "another")), secret, now)).toBe(false);
  });

  it("rejects a header that is damaged", () => {
    const good = sign(now);
    expect(verifyWebhook(body, `v1=${good}`, secret, now)).toBe(false); // no timestamp
    expect(verifyWebhook(body, `t=${now}`, secret, now)).toBe(false); // no signature
    expect(verifyWebhook(body, `t=abc,v1=${good}`, secret, now)).toBe(false);
    expect(verifyWebhook(body, `t=,v1=${good}`, secret, now)).toBe(false);
    expect(verifyWebhook(body, `t=-${now},v1=${good}`, secret, now)).toBe(false);
    expect(verifyWebhook(body, `t=${now}.5,v1=${good}`, secret, now)).toBe(false);
    expect(verifyWebhook(body, `t=${now},t=${now},v1=${good}`, secret, now)).toBe(false); // two timestamps
    expect(verifyWebhook(body, `t=${now},v1=${good.slice(0, 60)}`, secret, now)).toBe(false); // short
    expect(verifyWebhook(body, `t=${now},v1=${good}00`, secret, now)).toBe(false); // long
    expect(verifyWebhook(body, `t=${now},v1=${"z".repeat(64)}`, secret, now)).toBe(false); // not hex
    expect(verifyWebhook(body, `t=${now},v2=${good}`, secret, now)).toBe(false); // another scheme
    expect(verifyWebhook(body, "garbage", secret, now)).toBe(false);
  });

  it("tolerates spaces after the commas and capital hex", () => {
    expect(verifyWebhook(body, `t=${now}, v1=${sign(now).toUpperCase()}`, secret, now)).toBe(true);
  });

  it("signs the body as bytes, so accents and emoji work", () => {
    const raw = JSON.stringify({ type: "collection.succeeded", data: { checkout_id: "chk_x", name: "Chidiebere Okafor \u{1F600}" } });
    expect(verifyWebhook(raw, header(now, sign(now, raw)), secret, now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------- isPaid

describe("isPaid", () => {
  const REF = makeReference({ wallet: WALLET, usdcUnits: 10_000_000n, ngn: 1_550_000n }); // $10 for 15,500.00 naira
  const sess = (charge: Partial<BachsCharge> | null = {}, top: Partial<BachsSession> = {}): BachsSession => ({
    checkout_id: "chk_abc123",
    status: "completed",
    payment_status: "succeeded",
    reference: REF,
    currency: "NGN",
    charge: charge === null ? null : { payment_id: "ch_1", status: "succeeded", amount: "15500.00", amount_paid: "15500.00", currency: "NGN", ...charge },
    ...top,
  });

  it("pays on succeeded, accepted and overpaid", () => {
    expect(isPaid(sess({ status: "succeeded" }))).toBe(true);
    expect(isPaid(sess({ status: "accepted" }))).toBe(true);
    expect(isPaid(sess({ status: "overpaid", amount_paid: "16000.00" }))).toBe(true);
  });

  it("never pays on any other charge status", () => {
    for (const status of ["underpaid", "failed", "created", "processing", "expired", "cancelled", "refunded", "partially_refunded", "auto_refunded", "disputed", "", "paid", "success"]) {
      expect(isPaid(sess({ status })), status).toBe(false);
    }
    expect(isPaid(sess({ status: undefined }))).toBe(false);
  });

  it("reads the status in any case", () => {
    expect(isPaid(sess({ status: "SUCCEEDED" }))).toBe(true);
    expect(isPaid(sess({ status: "Overpaid", amount_paid: "15500.01" }))).toBe(true);
    expect(isPaid(sess({ status: "UNDERPAID" }))).toBe(false);
  });

  it("needs the paid amount to reach the price in the reference, in kobo", () => {
    expect(isPaid(sess({ status: "accepted", amount_paid: "15500.00" }))).toBe(true);
    expect(isPaid(sess({ status: "accepted", amount_paid: "15499.99" }))).toBe(false); // an accepted short payment
    expect(isPaid(sess({ status: "accepted", amount_paid: "100.00" }))).toBe(false);
    expect(isPaid(sess({ status: "accepted", amount_paid: "0.00" }))).toBe(false);
    expect(isPaid(sess({ status: "succeeded", amount_paid: "15499.99" }))).toBe(false);
    expect(isPaid(sess({ status: "overpaid", amount_paid: "15500.01" }))).toBe(true);
    expect(isPaid(sess({ status: "succeeded", amount_paid: "15500.000" }))).toBe(true);
    expect(isPaid(sess({ status: "succeeded", amount_paid: "15500.001" }))).toBe(false);
  });

  it("does not trust float arithmetic", () => {
    const tricky = makeReference({ wallet: WALLET, usdcUnits: 1_000_000n, ngn: 30_000n }); // 300.00
    const s = (paid: string) => sess({ status: "accepted", amount_paid: paid }, { reference: tricky });
    expect(isPaid(s("300.00"))).toBe(true);
    expect(isPaid(s("299.99"))).toBe(false);
    expect(isPaid(s("0.1"))).toBe(false);
  });

  it("uses the requested amount only for a charge that succeeded in full, and needs a paid amount otherwise", () => {
    expect(isPaid(sess({ status: "succeeded", amount_paid: null }))).toBe(true);
    expect(isPaid(sess({ status: "succeeded", amount_paid: undefined, amount: "15500.00" }))).toBe(true);
    expect(isPaid(sess({ status: "succeeded", amount_paid: null, amount: "100.00" }))).toBe(false);
    expect(isPaid(sess({ status: "accepted", amount_paid: null }))).toBe(false);
    expect(isPaid(sess({ status: "overpaid", amount_paid: null }))).toBe(false);
  });

  it("refuses an amount that is not a string of digits", () => {
    expect(isPaid(sess({ amount_paid: 15500 as unknown as string }))).toBe(false);
    expect(isPaid(sess({ amount_paid: "15,500.00" }))).toBe(false);
    expect(isPaid(sess({ amount_paid: "" }))).toBe(false);
    expect(isPaid(sess({ amount_paid: "abc" }))).toBe(false);
  });

  it("needs naira", () => {
    expect(isPaid(sess({ currency: "USD" }))).toBe(false);
    expect(isPaid(sess({ currency: "GHS" }))).toBe(false);
    expect(isPaid(sess({ currency: undefined }))).toBe(false);
    expect(isPaid(sess({}, { currency: "USD" }))).toBe(false);
    expect(isPaid(sess({ currency: "ngn" }))).toBe(true);
  });

  it("never pays on a reference that is missing, damaged or not ours", () => {
    for (const reference of [null, undefined, "", "ORD-1042", "tifo:0x1:5:7:abcd", REF.replace("tifo:", "other:")]) {
      expect(isPaid(sess({}, { reference })), String(reference)).toBe(false);
    }
  });

  it("is not paid when there is no charge, a nonsense session, or nothing at all", () => {
    expect(isPaid(sess(null))).toBe(false);
    expect(isPaid(null)).toBe(false);
    expect(isPaid(undefined)).toBe(false);
    expect(isPaid("paid" as unknown as BachsSession)).toBe(false);
    expect(isPaid({} as BachsSession)).toBe(false);
  });

  it("tells waiting from lost", () => {
    expect(paymentState(sess(null, { status: "open" }))).toBe("pending");
    expect(paymentState(sess(null, { status: "expired" }))).toBe("not_paid");
    expect(paymentState(sess(null, { status: "cancelled" }))).toBe("not_paid");
    expect(paymentState(sess({ status: "created" }))).toBe("pending");
    expect(paymentState(sess({ status: "processing" }))).toBe("pending");
    expect(paymentState(sess({ status: "failed" }, { status: "open" }))).toBe("pending"); // the page stays open for another try
    expect(paymentState(sess({ status: "failed" }, { status: "completed" }))).toBe("not_paid");
    expect(paymentState(sess({ status: "underpaid" }, { status: "open" }))).toBe("not_paid");
    expect(paymentState(sess({ status: "something_new" }, { status: "open" }))).toBe("not_paid");
    expect(paymentState(sess({}))).toBe("paid");
  });
});

// ---------------------------------------------------------------------------------------------- settings

describe("settings", () => {
  const all = { BACHS_SECRET_KEY: "sk_sandbox_abc", NAIRA_PER_USD: "1550", NAIRA_FLOAT: FLOAT, NEXT_PUBLIC_NETWORK: "testnet" };

  it("is on only when the key, the rate and the float address are all set", () => {
    expect(nairaConfig(all)).not.toBeNull();
    expect(nairaConfig({ ...all, BACHS_SECRET_KEY: "" })).toBeNull();
    expect(nairaConfig({ ...all, BACHS_SECRET_KEY: undefined })).toBeNull();
    expect(nairaConfig({ ...all, NAIRA_PER_USD: "" })).toBeNull();
    expect(nairaConfig({ ...all, NAIRA_PER_USD: "0" })).toBeNull();
    expect(nairaConfig({ ...all, NAIRA_PER_USD: "-3" })).toBeNull();
    expect(nairaConfig({ ...all, NAIRA_PER_USD: "lots" })).toBeNull();
    expect(nairaConfig({ ...all, NAIRA_FLOAT: "" })).toBeNull();
    expect(nairaConfig({ ...all, NAIRA_FLOAT: "0x1234" })).toBeNull();
    expect(nairaConfig({})).toBeNull();
  });

  it("picks the sandbox or the live API from the key", () => {
    expect(nairaConfig(all)?.base).toBe("https://sandbox-api.bachs.io");
    expect(nairaConfig({ ...all, NEXT_PUBLIC_NETWORK: "mainnet", BACHS_SECRET_KEY: "sk_live_abc" })?.base).toBe("https://api.bachs.io");
    // A sandbox key never runs against real USDC, and a live key never against test USDC.
    expect(nairaConfig({ ...all, NEXT_PUBLIC_NETWORK: "mainnet" })).toBeNull();
    expect(nairaConfig({ ...all, NEXT_PUBLIC_NETWORK: undefined })).toBeNull();
    expect(nairaConfig({ ...all, BACHS_SECRET_KEY: "sk_live_abc" })).toBeNull();
    expect(nairaConfig({ ...all, BACHS_SECRET_KEY: "sk_other_abc" })?.base).toBe("https://sandbox-api.bachs.io");
  });

  it("caps one payment at 50 dollars unless told otherwise, and tidies pasted values", () => {
    expect(nairaConfig(all)?.maxUsd).toBe(50);
    expect(nairaConfig({ ...all, NAIRA_MAX_USD: "120" })?.maxUsd).toBe(120);
    expect(nairaConfig({ ...all, NAIRA_MAX_USD: "nope" })?.maxUsd).toBe(50);
    expect(nairaConfig({ ...all, NAIRA_MAX_USD: "0" })?.maxUsd).toBe(50);
    const c = nairaConfig({ NEXT_PUBLIC_NETWORK: "testnet", BACHS_SECRET_KEY: ' "sk_sandbox_abc" ', NAIRA_PER_USD: " 1550.5 ", NAIRA_FLOAT: ` '${FLOAT}' `, BACHS_WEBHOOK_SECRET: " whsec_1 " });
    expect(c).toMatchObject({ key: "sk_sandbox_abc", rate: 1550.5, float: FLOAT_ADDR, webhookSecret: "whsec_1" });
  });

  it("nairaEnabled follows the environment", () => {
    vi.stubEnv("BACHS_SECRET_KEY", "");
    expect(nairaEnabled()).toBe(false);
    vi.stubEnv("BACHS_SECRET_KEY", "sk_sandbox_abc");
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "testnet");
    vi.stubEnv("NAIRA_PER_USD", "1550");
    expect(nairaEnabled()).toBe(false); // no float yet
    vi.stubEnv("NAIRA_FLOAT", FLOAT);
    expect(nairaEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});

// ---------------------------------------------------------------------------------------------- start and release (Bachs and the chain stubbed)

describe("starting and releasing", () => {
  const ID = "chk_abc123";
  const REF = makeReference({ wallet: WALLET, usdcUnits: 10_000_000n, ngn: 1_550_000n });
  const paid = (charge: Partial<BachsCharge> = {}, top: Partial<BachsSession> = {}): BachsSession => ({
    checkout_id: ID,
    status: "completed",
    reference: REF,
    currency: "NGN",
    charge: { payment_id: "ch_1", status: "succeeded", amount: "15500.00", amount_paid: "15500.00", currency: "NGN", ...charge },
    ...top,
  });

  let chain: Record<string, unknown>;
  const fetchMock = vi.fn();
  const answer = (status: number, body: unknown) => fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  const writes = () => h.writeContract.mock.calls.length;

  beforeEach(() => {
    vi.stubEnv("BACHS_SECRET_KEY", "sk_sandbox_secret_key_value");
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "testnet");
    vi.stubEnv("NAIRA_PER_USD", "1550");
    vi.stubEnv("NAIRA_FLOAT", FLOAT);
    vi.stubEnv("AGENT_PRIVATE_KEY", `0x${"11".repeat(32)}`);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    for (const m of Object.values(h)) m.mockReset();
    chain = { balanceOf: 1_000_000_000n, released: false, perRelease: 50_000_000n, perDay: 120_000_000n, releasedToday: 0n };
    h.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => chain[functionName]);
    h.simulateContract.mockImplementation(async (args: unknown) => ({ request: args }));
    h.writeContract.mockResolvedValue(HASH);
    h.waitForTransactionReceipt.mockResolvedValue({ status: "success" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("releases the USDC for a paid checkout, to the wallet in the reference, keyed by the checkout id", async () => {
    answer(200, paid());
    const r = await releaseFor(ID);
    expect(r).toEqual({ state: "released", hash: HASH });
    expect(writes()).toBe(1);
    const sim = h.simulateContract.mock.calls[0][0];
    expect(sim.functionName).toBe("release");
    expect(sim.address).toBe(FLOAT_ADDR);
    expect(sim.args).toEqual([keccak256(toBytes(ID)), WALLET, 10_000_000n]);
    // it asked Bachs about this checkout, with the key, and never sent the key anywhere else
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://sandbox-api.bachs.io/v1/checkout-sessions/${ID}`);
    expect(init.headers.authorization).toBe("Bearer sk_sandbox_secret_key_value");
    expect(init.method).toBe("GET");
  });

  it("does nothing while the payment is still on its way", async () => {
    answer(200, paid({ status: "processing" }, { status: "open" }));
    expect(await releaseFor(ID)).toEqual({ state: "pending" });
    answer(200, { ...paid(), charge: null, status: "open" });
    expect(await releaseFor(ID)).toEqual({ state: "pending" });
    expect(writes()).toBe(0);
  });

  it("does nothing for an underpaid, failed or short payment", async () => {
    for (const charge of [{ status: "underpaid" }, { status: "failed" }, { status: "accepted", amount_paid: "15499.99" }, { currency: "USD" }]) {
      answer(200, paid(charge));
      expect((await releaseFor(ID)).state).toBe("not_paid");
    }
    expect(writes()).toBe(0);
    expect(h.simulateContract).not.toHaveBeenCalled();
  });

  it("does nothing for a checkout that is not ours, or that Bachs does not know", async () => {
    answer(200, paid({}, { reference: "ORD-1042" }));
    expect((await releaseFor(ID)).state).toBe("not_paid");
    answer(404, { detail: "not found" });
    expect((await releaseFor(ID)).state).toBe("not_paid");
    answer(200, { ...paid(), checkout_id: "chk_someoneelse" }); // Bachs answered about a different checkout
    expect((await releaseFor(ID)).state).toBe("not_paid");
    expect((await releaseFor("not_a_checkout")).state).toBe("not_paid");
    expect((await releaseFor("chk_../../x")).state).toBe("not_paid");
    expect(writes()).toBe(0);
  });

  it("lets a Bachs outage through as an error, so the caller tries again later", async () => {
    answer(500, { detail: "down" });
    await expect(releaseFor(ID)).rejects.toThrow(/500/);
    answer(401, { detail: "bad key" });
    await expect(releaseFor(ID)).rejects.toThrow(/401/);
    fetchMock.mockRejectedValue(new Error("network"));
    await expect(releaseFor(ID)).rejects.toThrow();
    expect(writes()).toBe(0);
  });

  it("counts a checkout the float already paid as done, without sending anything", async () => {
    chain.released = true;
    answer(200, paid());
    expect(await releaseFor(ID)).toEqual({ state: "already" });
    expect(writes()).toBe(0);
  });

  it("counts an AlreadyReleased revert as done", async () => {
    h.simulateContract.mockRejectedValue(new Error('The contract function "release" reverted with the following reason: AlreadyReleased()'));
    answer(200, paid());
    expect(await releaseFor(ID)).toEqual({ state: "already" });
    expect(writes()).toBe(0);
  });

  it("counts a copy that reverted because another copy was paid first as done", async () => {
    h.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    h.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => (functionName === "released" ? (h.waitForTransactionReceipt.mock.calls.length > 0) : chain[functionName]));
    answer(200, paid());
    expect(await releaseFor(ID)).toEqual({ state: "already", hash: HASH });
  });

  it("fails loudly when the transaction reverted and the buyer was not paid", async () => {
    h.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    answer(200, paid());
    await expect(releaseFor(ID)).rejects.toThrow();
  });

  it("holds the payment when the float is short or at its limit", async () => {
    answer(200, paid());
    chain.balanceOf = 9_999_999n; // one unit short of the 10 dollars owed
    expect(await releaseFor(ID)).toEqual({ state: "float_short" });
    expect(writes()).toBe(0);
    chain.balanceOf = 1_000_000_000n;
    h.simulateContract.mockRejectedValue(new Error("reverted: OverLimit()"));
    expect(await releaseFor(ID)).toEqual({ state: "float_short" });
    expect(writes()).toBe(0);
  });

  it("sends one transaction when the webhook and the page ask at the same moment", async () => {
    answer(200, paid());
    const [a, b, c] = await Promise.all([releaseFor(ID), releaseFor(ID), releaseFor(ID)]);
    expect(writes()).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a.state).toBe("released");
  });

  it("does not keep a failure: the next call tries again", async () => {
    answer(500, {});
    await expect(releaseFor(ID)).rejects.toThrow();
    answer(200, paid());
    expect((await releaseFor(ID)).state).toBe("released");
  });

  it("fails if there is no agent key, rather than guessing", async () => {
    vi.stubEnv("AGENT_PRIVATE_KEY", "");
    answer(200, paid());
    await expect(releaseFor(ID)).rejects.toThrow(/AGENT_PRIVATE_KEY/);
  });

  it("refuses to release when naira payments are off", async () => {
    vi.stubEnv("NAIRA_FLOAT", "");
    await expect(releaseFor(ID)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ---- startCheckout

  const origin = "https://tifo.example";
  const go = (usd = 10n) => startCheckout({ wallet: WALLET, usdUnits: usd * 1_000_000n, promo: PROMO, origin });

  it("opens a Bachs checkout for the naira price with the charge in it, with our reference", async () => {
    answer(201, { checkout_id: ID, checkout_url: "https://checkout.bachs.io/c/abc", status: "open" });
    const r = await go(10n);
    // 15500 naira for the USDC, plus the 1.5% charge grossed up (15736.04), up to the next 10 naira
    expect(r).toEqual({ ok: true, checkoutUrl: "https://checkout.bachs.io/c/abc", checkoutId: ID, ngn: "15740.00", rate: 1550 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sandbox-api.bachs.io/v1/checkout-sessions");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.pricing).toEqual({ currency: "NGN", amount: "15740.00" });
    expect(body.payment_method_types).toEqual(["NGN_BANK_TRANSFER", "NGN_CARD"]);
    expect(body.expires_in_minutes).toBe(30);
    expect(body.customer_bears_fee).toBe(false); // the price shown already includes the charge
    expect(body.success_url).toBe(`${origin}/p/${PROMO}`);
    expect(body.cancel_url).toBe(`${origin}/p/${PROMO}`);
    expect(body).not.toHaveProperty("customer"); // a guest checkout
    const ref = parseReference(body.reference)!;
    expect(ref).toMatchObject({ wallet: WALLET, usdcUnits: 10_000_000n, ngn: 1_574_000n });
    expect(body.metadata).toMatchObject({ wallet: WALLET, usdc_units: "10000000" });
  });

  it("charges the rounded up price and the reference carries the same price", async () => {
    answer(201, { checkout_id: ID, checkout_url: "https://checkout.bachs.io/c/abc" });
    const r = await startCheckout({ wallet: WALLET, usdUnits: 3_333_333n, promo: PROMO, origin });
    expect(r).toMatchObject({ ok: true, ngn: "5250.00" }); // 5166.67 naira up to 5170, plus the charge (5248.73), up to 5250
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.pricing.amount).toBe(formatKobo(priceKobo(3_333_333n, 1550, 150, 200_000n)));
    expect(parseReference(body.reference)!.ngn).toBe(parseKobo(body.pricing.amount));
  });

  it("refuses when the float cannot pay it out, and never calls Bachs", async () => {
    chain.balanceOf = 9_999_999n;
    expect(await go(10n)).toEqual({ ok: false, error: "float_short" });
    chain.balanceOf = 1_000_000_000n;
    chain.releasedToday = 115_000_000n; // 115 + 10 is over the 120 a day
    expect(await go(10n)).toEqual({ ok: false, error: "float_short" });
    chain.releasedToday = 0n;
    chain.perRelease = 9_000_000n;
    expect(await go(10n)).toEqual({ ok: false, error: "too_large" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an amount outside 1 dollar to the cap", async () => {
    expect(await startCheckout({ wallet: WALLET, usdUnits: 999_999n, promo: PROMO, origin })).toEqual({ ok: false, error: "bad_amount" });
    expect(await startCheckout({ wallet: WALLET, usdUnits: 0n, promo: PROMO, origin })).toEqual({ ok: false, error: "bad_amount" });
    expect(await startCheckout({ wallet: WALLET, usdUnits: 50_010_000n, promo: PROMO, origin })).toEqual({ ok: false, error: "bad_amount" });
    expect(await startCheckout({ wallet: "0x12" as never, usdUnits: 5_000_000n, promo: PROMO, origin })).toEqual({ ok: false, error: "bad_amount" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says so when naira payments are off", async () => {
    vi.stubEnv("BACHS_SECRET_KEY", "");
    expect(await go()).toEqual({ ok: false, error: "disabled" });
  });

  it("does not hand the buyer a checkout address that is not https, or an id that is not one", async () => {
    answer(201, { checkout_id: ID, checkout_url: "http://checkout.bachs.io/c/abc" });
    expect(await go()).toEqual({ ok: false, error: "provider" });
    answer(201, { checkout_id: ID, checkout_url: "javascript:alert(1)" });
    expect(await go()).toEqual({ ok: false, error: "provider" });
    answer(201, { checkout_id: "oops", checkout_url: "https://checkout.bachs.io/c/abc" });
    expect(await go()).toEqual({ ok: false, error: "provider" });
    answer(400, { detail: "no" });
    expect(await go()).toEqual({ ok: false, error: "provider" });
  });

  it("never writes the key to the log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    answer(401, { detail: "bad key" });
    await go();
    expect(JSON.stringify(spy.mock.calls)).not.toContain("sk_sandbox_secret_key_value");
    spy.mockRestore();
  });
});
