// Read a seller's customers from whatever they have: a pasted list in any shape, a WhatsApp chat export, or a
// screenshot of their orders. The model reads; code normalizes every number and drops anything without a name or phone.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { chatSenders, newId, normalizePhone, parseLooseList, parseWhatsAppExport, type Customer } from "./customers";
import { MODEL } from "./model";

const SYSTEM = `You help a small online seller in Nigeria build a list of their own customers from what they paste or upload:
a messy list, a WhatsApp chat export, or a screenshot of orders. The seller is the shop owner (named shop below); never list them.
For each real customer return: name (as written, short), phone (exactly as written, or null), club (a football club or national
team they mention supporting, or null), purchases (what they bought and the date YYYY-MM-DD when visible; amount and currency
when visible). Only include people the input shows. Never invent a phone number or a purchase. Skip group names and system messages.`;

const nullable = (t: object) => ({ anyOf: [t, { type: "null" }] });
const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    customers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          phone: nullable({ type: "string" }),
          club: nullable({ type: "string" }),
          purchases: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { item: { type: "string" }, date: nullable({ type: "string" }), amount: nullable({ type: "number" }), currency: nullable({ type: "string" }) },
              required: ["item", "date", "amount", "currency"],
            },
          },
        },
        required: ["name", "phone", "club", "purchases"],
      },
    },
  },
  required: ["customers"],
};

interface Raw {
  name: string;
  phone: string | null;
  club: string | null;
  purchases: { item: string; date: string | null; amount: number | null; currency: string | null }[];
}

const isChatExport = (t: string) => parseWhatsAppExport(t.slice(0, 20_000)).length >= 3;

/** What the model reads: a chat export is compressed to who wrote, when, and their last messages. */
function forModel(text: string): string {
  if (!isChatExport(text)) return text.slice(0, 40_000);
  const senders = chatSenders(parseWhatsAppExport(text)).slice(0, 80);
  return `WhatsApp chat export, by sender:\n${senders
    .map((s) => `## ${s.sender}${s.phone ? ` (${s.phone})` : ""}, ${s.messages} messages, first ${s.first}, last ${s.last}\n${s.sample.join("\n")}`)
    .join("\n\n")}`.slice(0, 60_000);
}

function toCustomers(raw: Raw[], cc: string): Customer[] {
  const now = Math.floor(Date.now() / 1000);
  const rate = Number(process.env.NAIRA_PER_USD) || 1550;
  return raw
    .map((r) => ({
      id: newId(),
      name: (r.name ?? "").trim().slice(0, 60),
      phone: r.phone ? normalizePhone(r.phone, cc) : null,
      club: r.club?.trim().slice(0, 40) || undefined,
      purchases: (r.purchases ?? []).slice(0, 20).map((p) => ({
        item: p.item?.trim().slice(0, 60) || undefined,
        at: p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : undefined,
        amountUsd: p.amount && p.amount > 0 ? Math.round((/NGN|₦|naira/i.test(p.currency ?? "") ? p.amount / rate : p.amount) * 100) / 100 : undefined,
      })),
      source: "import" as const,
      addedAt: now,
    }))
    .filter((c) => c.name || c.phone)
    .map((c) => ({ ...c, name: c.name || "Customer" }));
}

/** Without the model: numbers and names from each line, or each sender of a chat export. */
export function readWithoutModel(text: string, shop: string | null, cc = "234"): Customer[] {
  const now = Math.floor(Date.now() / 1000);
  const rows = isChatExport(text)
    ? chatSenders(parseWhatsAppExport(text), cc)
        .filter((s) => !shop || s.sender.toLowerCase() !== shop.toLowerCase())
        .map((s) => ({ name: s.phone && /^[+\d]/.test(s.sender) ? "Customer" : s.sender, phone: s.phone, last: s.last }))
    : parseLooseList(text, cc).map((r) => ({ ...r, last: null as string | null }));
  return rows.map((r) => ({ id: newId(), name: r.name, phone: r.phone, purchases: r.last ? [{ at: r.last }] : [], source: "import" as const, addedAt: now }));
}

export async function importCustomers({ text, image, shop, cc = "234" }: { text?: string; image?: { data: string; mediaType: string }; shop: string | null; cc?: string }): Promise<{ customers: Customer[]; byModel: boolean }> {
  const content: Anthropic.ContentBlockParam[] = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: image.mediaType as "image/jpeg", data: image.data } });
  content.push({ type: "text", text: `Shop: ${shop ?? "unknown"}\n\n${text?.trim() ? forModel(text) : "Only the screenshot."}` });
  try {
    const client = new Anthropic();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content }],
    } as Parameters<typeof client.messages.create>[0] & { stream?: false });
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("no answer");
    const out = JSON.parse(block.text) as { customers: Raw[] };
    const list = toCustomers(out.customers ?? [], cc).filter((c) => !shop || c.name.toLowerCase() !== shop.toLowerCase());
    return { customers: list, byModel: true };
  } catch (e) {
    console.error("customer import fell back", e);
    if (!text?.trim()) throw new Error("We couldn't read that screenshot. Paste the names and numbers instead.");
    return { customers: readWithoutModel(text, shop, cc), byModel: false };
  }
}
