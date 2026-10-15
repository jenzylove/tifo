// Digital delivery. The seller's link or note is sealed with a server key and stored inside the
// drop's public metadata; only a buyer who can prove a paid order gets it opened.
// A v2 seal is bound to the wallet that made it (the seller who owns the drop), so the sealed text cannot be copied
// into someone else's drop and opened there. v1 seals, made before that, carry no owner.
import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function key(): Buffer {
  const secret = process.env.DELIVERY_SECRET;
  if (!secret || secret.length < 32) throw new Error("DELIVERY_SECRET is not set");
  return createHash("sha256").update(secret).digest();
}

export const deliveryEnabled = () => (process.env.DELIVERY_SECRET ?? "").length >= 32;

const aad = (owner: string) => Buffer.from(`tifo-owner:${owner.toLowerCase()}`, "utf8");

export function seal(text: string, owner: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(aad(owner));
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return `v2.${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url")}`;
}

/** Opens a seal. A v2 seal opens only for the owner it was made for. */
export function open(sealed: string, owner: string): string {
  const v = sealed.slice(0, 3);
  if (v !== "v1." && v !== "v2.") throw new Error("unknown delivery format");
  const raw = Buffer.from(sealed.slice(3), "base64url");
  const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  if (v === "v2.") d.setAAD(aad(owner));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

export const isV1 = (sealed: string) => sealed.startsWith("v1.");
