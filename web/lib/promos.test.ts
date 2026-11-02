import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 }); // the first import builds the chain clients
const OWN = "0xeab49a2DBb307068f25C81Bd419880DCd174C94B";

async function load(self = "") {
  vi.resetModules();
  process.env.SELF_WALLETS = self;
  return import("./promos");
}

describe("cachedRead", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("serves the last good value when a later read fails, and never an empty one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { cachedRead } = await load();
    expect(await cachedRead("k", async () => [1, 2, 3], 0)).toEqual([1, 2, 3]);
    const failing = vi.fn(async () => {
      throw new Error("rpc down");
    });
    expect(await cachedRead("k", failing, 0)).toEqual([1, 2, 3]);
    expect(failing).toHaveBeenCalledTimes(2); // retried once before falling back
  });

  it("throws when there was never a good value", async () => {
    const { cachedRead } = await load();
    await expect(cachedRead("fresh-key", async () => Promise.reject(new Error("rpc down")), 0)).rejects.toThrow("rpc down");
  });

  it("does not read again while the value is fresh", async () => {
    const { cachedRead } = await load();
    const read = vi.fn(async () => "ok");
    await cachedRead("f", read, 60_000);
    await cachedRead("f", read, 60_000);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("own wallets and check drops", () => {
  it("recognises SELF_WALLETS case insensitively", async () => {
    const { isOwnWallet, isOwnSeller } = await load(`${OWN.toLowerCase()}, 0x1111111111111111111111111111111111111111`);
    expect(isOwnWallet(OWN)).toBe(true);
    expect(isOwnSeller({ seller: OWN as never })).toBe(true);
    expect(isOwnWallet("0x2222222222222222222222222222222222222222")).toBe(false);
  });

  it("counts nobody as own when SELF_WALLETS is empty", async () => {
    const { isOwnWallet } = await load("");
    expect(isOwnWallet(OWN)).toBe(false);
  });

  it("takes own refunds out of the paid back total", async () => {
    const { ownRefundsPaid } = await load(OWN);
    const mk = (buyer: string, side: 0 | 1, refund: bigint) => ({ buyer: buyer as never, side, amount: 0n, rateBps: 0, at: 0, refund });
    const orders = [mk(OWN, 0, 5n), mk("0x2222222222222222222222222222222222222222", 0, 7n), mk(OWN, 1, 9n), mk(OWN, 0, 11n)];
    expect(ownRefundsPaid({ finalOutcome: "A", refundCursor: 3 }, orders)).toBe(5n); // order 3 not paid yet, order 2 lost
    expect(ownRefundsPaid({ finalOutcome: "Void", refundCursor: 4 }, orders)).toBe(0n);
  });

  it("treats a shop or product named test as a check drop", async () => {
    const { isCheckDrop } = await load();
    expect(isCheckDrop({ shop: "Test", product: "Shirt" })).toBe(true);
    expect(isCheckDrop({ shop: "Real Shop", product: "test" })).toBe(true);
    expect(isCheckDrop({ shop: "Real Shop", product: "Testing kit" })).toBe(false);
  });
});
