// Start a drop from a post the seller already made: a screenshot, the caption, or a link to the post.
// The model reads it and fills in what it can; the seller checks every field before anything is posted.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "./model";

export interface Imported {
  shop: string | null;
  product: string | null;
  priceUsd: number | null;
  priceNote: string | null; // e.g. "₦15,000 in the post, about $9.70"
  description: string | null;
  kind: "digital" | "physical" | "booking" | null;
  stock: number | null;
  image: string | null; // the post's photo, when it came from a link
}

const SYSTEM = `You read a small seller's social media post (a screenshot, its caption, or both) and pull out the one product it sells.
Return only what the post says or clearly shows; use null when it does not. price is the number shown, currency its ISO code
(NGN for ₦ or "naira", USD for $). kind is "digital" for downloads, templates, codes or courses, "booking" for appointments, sessions
or services at a time, otherwise "physical". product is a short name (under 60 characters). description is one plain sentence.`;

const nullable = (t: object) => ({ anyOf: [t, { type: "null" }] });
const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    shop: nullable({ type: "string" }),
    product: nullable({ type: "string" }),
    price: nullable({ type: "number" }),
    currency: nullable({ type: "string" }),
    description: nullable({ type: "string" }),
    kind: nullable({ type: "string", enum: ["digital", "physical", "booking"] }),
    stock: nullable({ type: "integer" }),
  },
  required: ["shop", "product", "price", "currency", "description", "kind", "stock"],
};

/** Only public web addresses: never this server's own network. */
export function publicUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return null;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[)/.test(h) || !h.includes(".")) return null;
    return u;
  } catch {
    return null;
  }
}

/** A public post page usually carries its photo and caption in og: tags. Instagram often hides them; then the screenshot is the way. */
export async function readLink(url: string): Promise<{ text: string | null; image: string | null }> {
  try {
    const u = publicUrl(url);
    if (!u) return { text: null, image: null };
    const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (compatible; TifoBot/1.0)" }, signal: AbortSignal.timeout(6000), redirect: "follow" });
    const html = (await r.text()).slice(0, 400_000);
    const tag = (p: string) => new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']+)`, "i").exec(html)?.[1] ?? null;
    const decode = (s: string | null) => s?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'") ?? null;
    const text = [decode(tag("title")), decode(tag("description"))].filter(Boolean).join("\n") || null;
    const image = decode(tag("image"));
    return { text, image: image && /^https:/.test(image) ? image : null };
  } catch {
    return { text: null, image: null };
  }
}

export async function importPost({ image, text, url }: { image?: string; text?: string; url?: string }): Promise<Imported> {
  let linkImage: string | null = null;
  let caption = text?.trim() || "";
  if (url) {
    const l = await readLink(url);
    linkImage = l.image;
    if (l.text) caption = [caption, l.text].filter(Boolean).join("\n");
  }
  const picture = image || linkImage;
  if (!picture && !caption) throw new Error("We couldn't read that post. Upload a screenshot of it instead.");

  const content: Anthropic.ContentBlockParam[] = [];
  if (picture) content.push({ type: "image", source: { type: "url", url: picture } });
  content.push({ type: "text", text: caption ? `Caption or page text:\n${caption.slice(0, 4000)}` : "No caption, only the screenshot." });

  const client = new Anthropic();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content }],
  } as Parameters<typeof client.messages.create>[0] & { stream?: false });
  const block = res.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("We couldn't read that post. Fill in the details yourself.");
  const o = JSON.parse(block.text) as { shop: string | null; product: string | null; price: number | null; currency: string | null; description: string | null; kind: Imported["kind"]; stock: number | null };

  // Prices in naira are turned into dollars at the rate the site already uses for naira payments.
  let priceUsd: number | null = null;
  let priceNote: string | null = null;
  const cur = (o.currency ?? "").toUpperCase();
  if (o.price && o.price > 0) {
    if (cur === "NGN") {
      const rate = Number(process.env.NAIRA_PER_USD) || 1550;
      priceUsd = Math.max(1, Math.round((o.price / rate) * 100) / 100);
      priceNote = `₦${o.price.toLocaleString("en-NG")} in the post, about $${priceUsd.toFixed(2)}`;
    } else if (!cur || cur === "USD") priceUsd = Math.round(o.price * 100) / 100;
    else priceNote = `${o.price} ${cur} in the post. Set the price in dollars.`;
  }
  const clip = (s: string | null, n: number) => (s ? s.trim().slice(0, n) || null : null);
  return {
    shop: clip(o.shop, 60),
    product: clip(o.product, 80),
    priceUsd,
    priceNote,
    description: clip(o.description, 240),
    kind: o.kind ?? null,
    stock: o.stock && o.stock > 0 ? Math.min(500, o.stock) : null,
    image: picture ?? null,
  };
}
