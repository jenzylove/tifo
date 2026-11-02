import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chatSenders,
  cycleDays,
  generalMessage,
  mergeCustomers,
  normalizePhone,
  ordersToCustomers,
  parseLooseList,
  parseWhatsAppExport,
  personalMessage,
  prioritize,
  waLink,
  type Customer,
} from "./customers";

describe("phone numbers become E.164, Nigerian by default", () => {
  it.each([
    ["0803 123 4567", "+2348031234567"],
    ["08031234567", "+2348031234567"],
    ["803-123-4567", "+2348031234567"],
    ["+234 803 123 4567", "+2348031234567"],
    ["2348031234567", "+2348031234567"],
    ["+234 (0) 803 123 4567", "+2348031234567"],
    ["00234 803 123 4567", "+2348031234567"],
    ["0902.222.3333", "+2349022223333"],
    ["+44 7700 900123", "+447700900123"],
    ["+1 (415) 555-0100", "+14155550100"],
  ])("%s -> %s", (raw, want) => expect(normalizePhone(raw)).toBe(want));
  it("refuses what is not a number", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("call me")).toBeNull();
    expect(normalizePhone("0803 123")).toBeNull();
    expect(normalizePhone("+234 803 123 45678 9")).toBeNull();
  });
});

describe("a WhatsApp chat export", () => {
  const text = readFileSync(new URL("./fixtures/whatsapp-chat.txt", import.meta.url), "utf8");
  const lines = parseWhatsAppExport(text);
  it("reads Android and iPhone lines, day first, and drops system lines", () => {
    expect(lines[0]).toEqual({ at: "2026-09-12", sender: "Glow Skincare", text: expect.stringContaining("shea butter") });
    expect(lines.some((l) => /encrypted/.test(l.text))).toBe(false);
    const tunde = lines.find((l) => l.sender === "Tunde Bakare")!;
    expect(tunde.at).toBe("2026-10-21");
    expect(tunde.text).toContain("continuation line");
    expect(lines.some((l) => /Media omitted/.test(l.text))).toBe(false);
  });
  it("finds each sender with their number, from the sender line or what they wrote", () => {
    const s = Object.fromEntries(chatSenders(lines).map((x) => [x.sender, x]));
    expect(s["Ada Obi"].phone).toBe("+2348031234567");
    expect(s["+234 805 555 1234"].phone).toBe("+2348055551234");
    expect(s["Chioma"].phone).toBe("+2349022223333");
    expect(s["Ada Obi"].last).toBe("2026-09-12");
    expect(s["Tunde Bakare"].phone).toBeNull();
  });
});

describe("a pasted list in any shape", () => {
  it("takes the number from each line and the rest as the name", () => {
    const out = parseLooseList("1. Ada Obi - 0803 123 4567\nTunde,+234 805 555 1234\nChioma | 09022223333 ; Emeka 07011112222\n\n");
    expect(out).toEqual([
      { name: "Ada Obi", phone: "+2348031234567" },
      { name: "Tunde", phone: "+2348055551234" },
      { name: "Chioma", phone: "+2349022223333" },
      { name: "Emeka", phone: "+2347011112222" },
    ]);
  });
});

const now = Date.parse("2026-11-02T12:00:00Z");
const c = (id: string, name: string, phone: string | null, extra: Partial<Customer> = {}): Customer => ({ id, name, phone, purchases: [], source: "import", addedAt: 0, ...extra });

describe("merging", () => {
  it("joins the same phone and keeps both purchases", () => {
    const a = c("1", "Ada", "+2348031234567", { purchases: [{ item: "shea butter", at: "2026-09-12" }] });
    const b = c("2", "Ada Obi", "+2348031234567", { club: "Arsenal", purchases: [{ item: "serum", at: "2026-10-01" }] });
    const out = mergeCustomers([a], [b]);
    expect(out).toHaveLength(1);
    expect(out[0].club).toBe("Arsenal");
    expect(out[0].purchases).toHaveLength(2);
  });
  it("turns guest checkout orders into customers, side into club", () => {
    const drop = "0x" + "a".repeat(40);
    const out = ordersToCustomers(
      [
        { phone: "0803 123 4567", side: 1, amountUsd: 8, at: 1_790_000_000, drop },
        { phone: "+2348031234567", side: 1, amountUsd: 8, at: 1_790_000_000, drop },
        { phone: "nonsense", side: 0, amountUsd: 8, at: 1_790_000_000, drop },
      ],
      { [drop]: { teamA: "Arsenal FC", teamB: "Chelsea FC", product: "Shea butter" } },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ phone: "+2348031234567", club: "Chelsea", source: "order" });
    expect(out[0].purchases[0].item).toBe("Shea butter");
  });
});

describe("WhatsApp links", () => {
  it("uses digits only and encodes the message", () => {
    expect(waLink("+2348031234567", "Hi Ada, 50% back & more?")).toBe("https://wa.me/2348031234567?text=Hi%20Ada%2C%2050%25%20back%20%26%20more%3F");
  });
});

describe("who to message first", () => {
  const list = [
    c("stranger", "Bisi", "+2348000000001"),
    c("recent", "Kemi", "+2348000000002", { purchases: [{ item: "shea butter", at: "2026-10-28" }] }),
    c("due", "Ada", "+2348000000003", { purchases: [{ item: "shea butter", at: "2026-09-25" }] }),
    c("fan", "Tunde", "+2348000000004", { club: "Arsenal", purchases: [{ item: "shea butter", at: "2026-10-25" }] }),
    c("nonumber", "Femi", null, { club: "Arsenal", purchases: [{ item: "shea butter", at: "2026-08-01" }] }),
  ];
  const r = prioritize(list, { teams: ["Arsenal FC", "Chelsea FC"], product: "Shea butter", now });
  it("puts fans of the clubs playing and people due again first, and no number last", () => {
    expect(r.map((x) => x.customer.id)).toEqual(["fan", "due", "stranger", "recent", "nonumber"]);
    expect(r.find((x) => x.customer.id === "due")!.due).toBe(true);
    expect(r.find((x) => x.customer.id === "fan")!.fan).toBe("Arsenal");
  });
  it("guesses how often a product is bought again", () => {
    expect(cycleDays("Shea butter")).toBe(30);
    expect(cycleDays("Small chops tray")).toBe(7);
    expect(cycleDays("Notion template")).toBe(90);
  });
});

describe("messages", () => {
  const drop = { shop: "Glow", product: "Shea butter", teamA: "Arsenal FC", teamB: "Chelsea FC", backBps: 5_000, kickoff: "2026-11-07T17:30:00Z", url: "https://tifo-preview.vercel.app/p/0xabc" };
  const banned = /\b(odds|bet|bets|betting|stake|wager)\b|[‒-―]|\w-\w/i;
  const strip = (m: string) => m.replace(drop.url, "");
  it("the general message says the offer as money back if a club wins, with the link intact", () => {
    const m = generalMessage(drop);
    expect(m).toContain("half your money back if your club wins");
    expect(m.endsWith(drop.url)).toBe(true);
    expect(strip(m)).not.toMatch(banned);
  });
  it("a fan gets their club by name, their last purchase, and no betting words or dashes", () => {
    const fan = c("1", "Tunde Bakare", "+2348000000004", { club: "Arsenal", purchases: [{ item: "Shea butter", at: "2026-10-01" }] });
    const m = personalMessage(fan, drop);
    expect(m).toMatch(/^Hello Tunde, it's Glow\./);
    expect(m).toContain("running low");
    expect(m).toContain("pick Arsenal, and get half your money back if Arsenal win");
    expect(strip(m)).not.toMatch(banned);
  });
  it("cleans a product name with a dash or a betting word", () => {
    const m = personalMessage(c("2", "Ada", null), { ...drop, product: "Anti-acne bet kit — big" });
    expect(strip(m)).not.toMatch(banned);
  });
});
