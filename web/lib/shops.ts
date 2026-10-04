// Shop profiles live in the TifoShops registry on Arc. Only the shop's own wallet can write its page.
import type { Address } from "viem";
import { tifoShopsAbi } from "./abi";
import { SHOPS, publicClient } from "./chain";

export interface Product {
  id: string;
  name: string;
  priceUsd: number;
  image?: string;
  description?: string;
}

export interface ShopProfile {
  name: string;
  tagline?: string;
  bio?: string;
  logo?: string;
  cover?: string;
  color?: string; // brand accent
  city?: string;
  teams?: string[]; // clubs the shop's buyers follow
  links?: { whatsapp?: string; instagram?: string; x?: string; tiktok?: string; website?: string };
  products: Product[];
}

export interface Shop {
  owner: Address;
  handle: string;
  profile: ShopProfile;
  updatedAt: number;
}

const ZERO = "0x0000000000000000000000000000000000000000";

function parse(s: { owner: Address; handle: string; profile: string; updatedAt: bigint }): Shop | null {
  if (s.owner === ZERO) return null;
  try {
    const profile = JSON.parse(s.profile) as ShopProfile;
    profile.products ??= [];
    return { owner: s.owner, handle: s.handle, profile, updatedAt: Number(s.updatedAt) };
  } catch {
    return null;
  }
}

export async function shopByHandle(handle: string): Promise<Shop | null> {
  const s = await publicClient.readContract({ address: SHOPS, abi: tifoShopsAbi, functionName: "shopByHandle", args: [handle.toLowerCase()] });
  return parse(s);
}

export async function shopOf(owner: Address): Promise<Shop | null> {
  const s = await publicClient.readContract({ address: SHOPS, abi: tifoShopsAbi, functionName: "shopOf", args: [owner] });
  return parse(s);
}

export async function listShops(): Promise<Shop[]> {
  const n = Number(await publicClient.readContract({ address: SHOPS, abi: tifoShopsAbi, functionName: "shopsCount" }));
  if (!n) return [];
  const page = await publicClient.readContract({ address: SHOPS, abi: tifoShopsAbi, functionName: "getShops", args: [0n, BigInt(n)] });
  return page.map(parse).filter((s): s is Shop => !!s);
}

/** wa.me link with a prefilled message. Accepts "+234 803…" or a full link. */
export function whatsappLink(raw: string, text: string): string {
  if (/^https?:/.test(raw)) return raw;
  const digits = raw.replace(/[^\d]/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export function socialLinks(p: ShopProfile): { label: string; href: string }[] {
  const l = p.links ?? {};
  const out: { label: string; href: string }[] = [];
  const handle = (v: string) => v.replace(/^@/, "");
  if (l.whatsapp) out.push({ label: "WhatsApp", href: whatsappLink(l.whatsapp, `Hi ${p.name}`) });
  if (l.instagram) out.push({ label: "Instagram", href: /^https?:/.test(l.instagram) ? l.instagram : `https://instagram.com/${handle(l.instagram)}` });
  if (l.tiktok) out.push({ label: "TikTok", href: /^https?:/.test(l.tiktok) ? l.tiktok : `https://tiktok.com/@${handle(l.tiktok)}` });
  if (l.x) out.push({ label: "X", href: /^https?:/.test(l.x) ? l.x : `https://x.com/${handle(l.x)}` });
  if (l.website) out.push({ label: "Website", href: /^https?:/.test(l.website) ? l.website : `https://${l.website}` });
  return out;
}
