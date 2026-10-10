// Digital delivery. The seller's link or note is sealed with a server key and stored inside the
// drop's public metadata; only a buyer who can prove a paid order gets it opened.
import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function key(): Buffer {
  const secret = process.env.DELIVERY_SECRET;
  if (!secret || secret.length < 32) throw new Error("DELIVERY_SECRET is not set");
  return createHash("sha256").update(secret).digest();
}

export const deliveryEnabled = () => (process.env.DELIVERY_SECRET ?? "").length >= 32;

export function seal(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url")}`;
}

export function open(sealed: string): string {
  if (!sealed.startsWith("v1.")) throw new Error("unknown delivery format");
  const raw = Buffer.from(sealed.slice(3), "base64url");
  const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}
