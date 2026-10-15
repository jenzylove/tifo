import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const SELLER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

beforeAll(() => {
  process.env.DELIVERY_SECRET = "x".repeat(40);
});

describe("sealed delivery", () => {
  it("opens for the seller it was sealed for, whatever the address case", async () => {
    const { seal, open } = await import("./delivery");
    const s = seal("https://example.com/file", SELLER);
    expect(s.startsWith("v2.")).toBe(true);
    expect(s).not.toContain("example.com");
    expect(open(s, SELLER.toUpperCase().replace("0X", "0x"))).toBe("https://example.com/file");
  });

  it("refuses a seal copied into another seller's drop", async () => {
    const { seal, open } = await import("./delivery");
    expect(() => open(seal("secret", SELLER), OTHER)).toThrow();
  });

  it("still opens older v1 seals", async () => {
    const { open, isV1 } = await import("./delivery");
    const key = createHash("sha256").update(process.env.DELIVERY_SECRET!).digest();
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([c.update("old note", "utf8"), c.final()]);
    const v1 = `v1.${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url")}`;
    expect(isV1(v1)).toBe(true);
    expect(open(v1, OTHER)).toBe("old note");
  });

  it("refuses a tampered seal", async () => {
    const { seal, open } = await import("./delivery");
    const s = seal("secret", SELLER);
    const bad = s.slice(0, -2) + (s.endsWith("A") ? "BB" : "AA");
    expect(() => open(bad, SELLER)).toThrow();
  });
});
