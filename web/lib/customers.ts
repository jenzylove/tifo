// A seller's own customers: the people who bought before on WhatsApp or Instagram. Pure helpers shared by the server
// (import, storage, merging guest orders) and the browser (share pack, WhatsApp links). Phone numbers never go on
// chain or into a public API; they live sealed in the seller's own record (lib/customerStore.ts).
import { shortTeam } from "./matches";

export interface Purchase {
  item?: string;
  at?: string; // YYYY-MM-DD when known
  amountUsd?: number;
  drop?: string; // a Tifo drop address, for orders merged from checkout
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null; // E.164, e.g. +2348031234567
  club?: string;
  purchases: Purchase[];
  note?: string;
  source: "import" | "order" | "manual";
  addedAt: number; // unix seconds
}

/** What a seller signs (once per 12 hours) to open their customer list. Names the address and the time, so it cannot be reused. */
export const sessionMessage = (address: string, at: number) => `Tifo: open my customer list for ${address.toLowerCase()} (${at})`;

/** Normalize a phone number to E.164. Nigerian by default: 0803..., 803..., 234803..., +234 803... all become +234803.... */
export function normalizePhone(raw: string, cc = "234"): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let d = s.replace(/[^\d+]/g, "");
  if (!d) return null;
  if (d.startsWith("+")) d = d.slice(1).replace(/\+/g, "");
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith(cc) && d.length >= cc.length + 9) {
    // already has the country code, written without the plus
  } else if (d.startsWith("0")) d = cc + d.slice(1);
  else if (cc === "234" && d.length === 10 && /^[789]/.test(d)) d = cc + d;
  else if (d.length <= 10) d = cc + d;
  d = d.replace(/^(234)0/, "$1"); // +234 0803... written with the trunk zero
  if (d.startsWith("234") && d.length !== 13) return null; // Nigerian numbers: 234 + 10 digits
  if (d.length < 8 || d.length > 15) return null;
  return `+${d}`;
}

const PHONE_RE = /(?:\+|00)?\d[\d\s().-]{7,17}\d/g;

/** Every phone number written in a piece of text. */
export function findPhones(text: string, cc = "234"): string[] {
  const out = new Set<string>();
  for (const m of text.match(PHONE_RE) ?? []) {
    const p = normalizePhone(m, cc);
    if (p) out.add(p);
  }
  return [...out];
}

export interface ChatLine {
  at: string | null; // YYYY-MM-DD
  sender: string;
  text: string;
}

// "12/03/2026, 14:22 - Ada Obi: text"  or  "[12/03/2026, 14:22:05] Ada Obi: text"  (Android and iPhone exports)
const LINE_RE = /^‎?\[?(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?\]?\s*(?:-|–)?\s*([^:]{1,60}):\s?(.*)$/;

/** Parse a WhatsApp chat export (.txt) into lines. Continuation lines join the message above. System lines are dropped. */
export function parseWhatsAppExport(text: string): ChatLine[] {
  const out: ChatLine[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/[‎‏‪-‮]/g, "");
    const m = LINE_RE.exec(line);
    if (m) {
      const [, a, b, y, , , sender, body] = m;
      const year = y.length === 2 ? `20${y}` : y;
      // Most exports from Nigeria are day first. A first number over 12 is certainly the day; a second over 12 means month first.
      const [day, month] = Number(b) > 12 ? [a, b].reverse() : [a, b];
      out.push({ at: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`, sender: sender.trim(), text: body.trim() });
    } else if (out.length && line.trim() && !/^<Media omitted>$/.test(line.trim())) out[out.length - 1].text += `\n${line.trim()}`;
  }
  return out.filter((l) => !/^<Media omitted>$|^This message was deleted$|end-to-end encrypted/i.test(l.text));
}

export interface Sender {
  sender: string;
  phone: string | null;
  messages: number;
  first: string | null;
  last: string | null;
  sample: string[]; // a few messages, for the model to read what they bought
}

/** Who wrote in a chat export, with their number when the sender is shown as one, and their last messages. */
export function chatSenders(lines: ChatLine[], cc = "234"): Sender[] {
  const by = new Map<string, Sender>();
  for (const l of lines) {
    const s = by.get(l.sender) ?? { sender: l.sender, phone: /^[+\d][\d\s().-]{6,}$/.test(l.sender) ? normalizePhone(l.sender, cc) : null, messages: 0, first: l.at, last: l.at, sample: [] };
    s.messages++;
    s.last = l.at ?? s.last;
    if (!s.phone) s.phone = findPhones(l.text, cc)[0] ?? null;
    s.sample.push(l.text.slice(0, 200));
    if (s.sample.length > 12) s.sample.shift();
    by.set(l.sender, s);
  }
  return [...by.values()].sort((a, b) => b.messages - a.messages);
}

/** The fallback reader for a pasted list: one customer per line with a phone number, the rest of the line as the name. */
export function parseLooseList(text: string, cc = "234"): { name: string; phone: string | null }[] {
  const out: { name: string; phone: string | null }[] = [];
  for (const line of text.replace(/\r/g, "").split(/\n|;/)) {
    const phones = line.match(PHONE_RE) ?? [];
    const phone = phones.map((p) => normalizePhone(p, cc)).find(Boolean) ?? null;
    let name = line;
    for (const p of phones) name = name.replace(p, " ");
    name = name.replace(/[,|:\t]+/g, " ").replace(/\s+/g, " ").replace(/^[\s\d.)*-]+/, "").replace(/[\s\-–—.]+$/, "").trim();
    if (!phone && !name) continue;
    if (!phone && name.split(" ").length > 4) continue; // a sentence, not a customer
    out.push({ name: name.slice(0, 60) || "Customer", phone });
  }
  return out;
}

const key = (c: Pick<Customer, "name" | "phone">) => c.phone ?? `name:${c.name.trim().toLowerCase()}`;

const samePurchase = (a: Purchase, b: Purchase) => (a.drop && a.drop === b.drop) || (!a.drop && !b.drop && a.item === b.item && a.at === b.at);

/** Add new customers to a list: same phone (or same name with no phone) is the same person; purchases are combined. */
export function mergeCustomers(list: Customer[], incoming: Customer[]): Customer[] {
  const out = list.map((c) => ({ ...c, purchases: [...c.purchases] }));
  const idx = new Map(out.map((c, i) => [key(c), i]));
  for (const c of incoming) {
    const i = idx.get(key(c));
    if (i === undefined) {
      idx.set(key(c), out.length);
      out.push(c);
      continue;
    }
    const e = out[i];
    if ((!e.name || /^customer$/i.test(e.name)) && c.name) e.name = c.name;
    if (!e.club && c.club) e.club = c.club;
    for (const p of c.purchases) if (!e.purchases.some((q) => samePurchase(p, q))) e.purchases.push(p);
  }
  return out;
}

/** A guest checkout order, recorded with the buyer's phone. */
export interface OrderIn {
  phone: string;
  name?: string;
  side?: 0 | 1;
  club?: string;
  amountUsd: number;
  at: number | string; // unix seconds or ISO
  drop: string;
  item?: string;
}

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** Turn checkout orders into customers. `teams` gives each drop's clubs (so a side becomes a club) and product. */
export function ordersToCustomers(orders: OrderIn[], drops: Record<string, { teamA: string; teamB: string; product: string }> = {}): Customer[] {
  const out: Customer[] = [];
  for (const o of orders) {
    const phone = normalizePhone(o.phone);
    if (!phone) continue;
    const d = drops[o.drop.toLowerCase()];
    const club = o.club ?? (d && o.side !== undefined ? shortTeam(o.side === 0 ? d.teamA : d.teamB) : undefined);
    const at = typeof o.at === "number" ? new Date(o.at * 1000).toISOString().slice(0, 10) : o.at.slice(0, 10);
    out.push({
      id: newId(),
      name: (o.name ?? "").trim().slice(0, 60) || "Customer",
      phone,
      club,
      purchases: [{ item: o.item ?? d?.product, at, amountUsd: o.amountUsd, drop: o.drop.toLowerCase() }],
      source: "order",
      addedAt: Math.floor(Date.now() / 1000),
    });
  }
  return mergeCustomers([], out);
}

/** A WhatsApp link that opens a chat with the message typed in. */
export function waLink(phone: string, text: string): string {
  return `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

/** How often people buy this kind of product again, in days. A rough guess from the product's name. */
export function cycleDays(product: string): number {
  const p = product.toLowerCase();
  const rules: [RegExp, number][] = [
    [/cake|food|snack|chops|meal|jollof|small chops|drink|juice|zobo|bread|pastr/, 7],
    [/data|airtime|subscription|gift card/, 30],
    [/cream|serum|soap|lotion|skin|butter|oil|toner|cleanser|scrub|glow|sunscreen|body|face|gua sha|lip/, 30],
    [/perfume|fragrance|scent|spray|deodorant|candle/, 45],
    [/hair|wig|bundle|braid|lash|nail/, 45],
    [/shoe|sneaker|bag|dress|shirt|gown|ankara|jersey|cloth|wear|abaya|trouser|jean/, 60],
    [/template|course|ebook|e book|guide|preset|class|lesson|consult/, 90],
    [/phone|laptop|gadget|watch|earbud|headphone|charger/, 120],
  ];
  for (const [re, d] of rules) if (re.test(p)) return d;
  return 30;
}

const daysSince = (iso: string | undefined, now: number) => (iso ? (now - Date.parse(iso)) / 86_400_000 : null);

export function lastPurchase(c: Customer): Purchase | undefined {
  return [...c.purchases].filter((p) => p.at).sort((a, b) => (a.at! < b.at! ? 1 : -1))[0] ?? c.purchases[c.purchases.length - 1];
}

/** Does the customer support one of these clubs? Returns the drop's own name for it. */
export function fanOf(c: Customer, teams: [string, string]): string | null {
  if (!c.club) return null;
  const want = c.club.toLowerCase().replace(/\b(fc|afc|cf)\b/g, "").trim();
  if (!want) return null;
  for (const t of teams) {
    const full = t.toLowerCase(), short = shortTeam(t).toLowerCase();
    if (full.includes(want) || short.includes(want) || want.includes(short)) return shortTeam(t);
  }
  return null;
}

export interface Ranked {
  customer: Customer;
  score: number;
  due: boolean; // time since the last purchase is past the product's cycle
  fan: string | null; // the club playing that they support
}

/** Who to message first: fans of the clubs playing, and people due to buy again, then everyone else. */
export function prioritize(list: Customer[], o: { teams: [string, string]; product: string; now?: number }): Ranked[] {
  const now = o.now ?? Date.now();
  const cycle = cycleDays(o.product);
  return list
    .map((customer) => {
      const fan = fanOf(customer, o.teams);
      const since = daysSince(lastPurchase(customer)?.at, now);
      const due = since !== null && since >= cycle * 0.8;
      // Due counts most when they are around one cycle late; long gone customers still rank above strangers.
      const dueScore = since === null ? 0.5 : Math.min(2, since / cycle);
      const score = (fan ? 2 : 0) + dueScore + (customer.purchases.length ? 0.3 : 0) + (customer.phone ? 0 : -5);
      return { customer, score, due, fan };
    })
    .sort((a, b) => b.score - a.score);
}

export interface DropForMessage {
  shop: string;
  product: string;
  teamA: string;
  teamB: string;
  backBps: number;
  kickoff: string; // ISO; the sale ends at kickoff
  url: string;
}

const backWords = (bps: number) => (bps >= 10_000 ? "all your money back" : bps >= 5_000 ? "half your money back" : `${Math.round(bps / 100)}% of your money back`);
const ends = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "long", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Africa/Lagos" }).replace(":00", "");

/** No dashes, no betting words, whatever went in. */
export function tidy(s: string): string {
  return s
    .replace(/\s*[‒-―]\s*/g, ", ")
    .replace(/(\w)-(\w)/g, "$1 $2")
    .replace(/\b(odds|bets?|betting|stakes?|staking|wagers?|punt)\b/gi, "")
    .replace(/ {2,}/g, " ")
    .replace(/ ([,.!?])/g, "$1")
    .trim();
}

/** The one message for a WhatsApp status or an Instagram story. */
export function generalMessage(d: DropForMessage): string {
  const A = shortTeam(d.teamA), B = shortTeam(d.teamB);
  // The link is added after tidying, so a hyphen in a web address stays.
  return `${tidy(`${A} or ${B}? Buy ${d.product} from ${d.shop} at the normal price, pick your club, and get ${backWords(d.backBps)} if your club wins. Sale ends ${ends(d.kickoff)}.`)} ${d.url}`;
}

const first = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/** A personal message for one customer: their name, what they last bought, their club, the match and the offer. */
export function personalMessage(c: Customer, d: DropForMessage, fan: string | null = fanOf(c, [d.teamA, d.teamB])): string {
  const A = shortTeam(d.teamA), B = shortTeam(d.teamB);
  const hi = /^customer$/i.test(c.name) ? "Hello" : `Hello ${first(c.name)}`;
  const lp = lastPurchase(c);
  const back = backWords(d.backBps);
  const lines = [`${hi}, it's ${d.shop}.`];
  if (lp?.item && lp.item.toLowerCase() === d.product.toLowerCase()) lines.push(`Your last ${lp.item} should be running low by now.`);
  else if (lp?.item) lines.push(`Thank you again for buying ${lp.item} from us.`);
  if (fan) lines.push(`${fan} play ${fan === A ? B : A} this ${new Date(d.kickoff).toLocaleDateString("en-GB", { weekday: "long", timeZone: "Africa/Lagos" })}. Buy ${d.product} at the normal price, pick ${fan}, and get ${back} if ${fan} win.`);
  else lines.push(`For ${A} v ${B}, buy ${d.product} at the normal price, pick your club, and get ${back} if your club wins.`);
  lines.push(`Sale ends ${ends(d.kickoff)}:`);
  return `${tidy(lines.join(" "))} ${d.url}`;
}
