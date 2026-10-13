// Opens practice drops on Arc testnet so anyone can try the full flow with free test USDC.
// Each drop comes from its own seller wallet, on a real upcoming match, and is marked as practice in its metadata.
// Seller wallets are derived from PRACTICE_SEED, so a rerun reuses the same sellers. The funder tops each one up
// with a little test USDC for gas.
//
// Usage:
//   FUNDER_PK=0x... FACTORY=0x<testnet factory> PRACTICE_SEED=<any secret string> \
//   PRACTICE_URL=https://<practice site> COUNT=20 npx tsx scripts/seed-practice.mts
// DRY=1 prints the plan without sending anything.
import { createPublicClient, createWalletClient, erc20Abi, http, keccak256, parseUnits, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tifoFactoryAbi } from "../web/lib/abi.ts";
import { arcTestnet } from "../web/lib/chain.ts";
import { upcomingMatches, type Match } from "../web/lib/matches.ts";

const env = process.env as Record<string, string | undefined>;
const need = (k: string): string => env[k]?.trim() || (() => { console.log(`::error::secret ${k} is not set`); process.exit(1); })();
// In GitHub Actions, notices and errors show on the run page (and through the API), not only in the raw log.
const GH = !!env.GITHUB_ACTIONS;
const note = (m: string) => console.log(GH ? `::notice::${m}` : m);
const fail = (m: string) => console.log(GH ? `::error::${m}` : `ERROR ${m}`);
for (const ev of ["unhandledRejection", "uncaughtException"] as const) process.on(ev, (e) => { fail(String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
const DRY = env.DRY === "1";
const COUNT = Number(env.COUNT ?? 20);
const FACTORY = need("FACTORY") as Hex;
const SEED = need("PRACTICE_SEED");
const SITE = need("PRACTICE_URL").replace(/\/$/, "");
const USDC = "0x3600000000000000000000000000000000000000" as const;
const GAS_FLOAT = parseUnits("0.3", 6); // test USDC each seller keeps for gas
const FULL = 10_000, DRAW = 500;

const pub = createPublicClient({ chain: arcTestnet, transport: http() });
const funder = DRY ? null : createWalletClient({ account: privateKeyToAccount(need("FUNDER_PK") as Hex), chain: arcTestnet, transport: http() });

// Invented practice shops. Half sell something digital (it opens on the page after paying), half something shipped.
const SHOPS: { shop: string; product: string; price: number; spots: number; digital: boolean; description: string }[] = [
  { shop: "Kola Prints", product: "Matchday poster pack", price: 3, spots: 2, digital: true, description: "Six printable posters for your wall." },
  { shop: "Ada Bakes", product: "Chin chin, large jar", price: 4, spots: 2, digital: false, description: "Crunchy, sweet, made fresh." },
  { shop: "Glow by Ify", product: "Shea body butter", price: 5, spots: 2, digital: false, description: "Whipped shea with a light citrus scent." },
  { shop: "Tunde Templates", product: "Budget planner sheet", price: 2, spots: 3, digital: true, description: "Monthly budget tracker you can copy." },
  { shop: "Thread Lane", product: "Team colour wristband", price: 2, spots: 3, digital: false, description: "Woven band in your side's colours." },
  { shop: "Chef Nkem", product: "Jollof recipe ebook", price: 3, spots: 2, digital: true, description: "Twelve party jollof recipes." },
  { shop: "Pure Leaf", product: "Hibiscus tea, 20 bags", price: 4, spots: 2, digital: false, description: "Zobo tea, no added sugar." },
  { shop: "Beatroom", product: "Afrobeats drum kit", price: 5, spots: 2, digital: true, description: "120 drum samples for producers." },
  { shop: "Soft Glow", product: "Clay face mask", price: 3, spots: 2, digital: false, description: "Kaolin clay mask for oily skin." },
  { shop: "Lens & Light", product: "Lightroom preset pack", price: 2, spots: 3, digital: true, description: "Ten warm presets for phone photos." },
  { shop: "Mama Cee Snacks", product: "Plantain chips, 6 packs", price: 3, spots: 2, digital: false, description: "Salted and sweet." },
  { shop: "Study Hub", product: "Exam timetable kit", price: 2, spots: 3, digital: true, description: "Printable study planner." },
  { shop: "Ankara Corner", product: "Ankara tote bag", price: 6, spots: 1, digital: false, description: "Lined tote with a zip pocket." },
  { shop: "FitWith Femi", product: "4 week home workout plan", price: 4, spots: 2, digital: true, description: "No equipment needed." },
  { shop: "Scent Story", product: "Mini perfume oil", price: 5, spots: 2, digital: false, description: "10ml roll-on, oud and vanilla." },
  { shop: "Code Kitchen", product: "Portfolio site template", price: 5, spots: 2, digital: true, description: "One page site, ready to edit." },
  { shop: "Brew Spot", product: "Cold brew coffee bottle", price: 3, spots: 2, digital: false, description: "500ml, ready to drink." },
  { shop: "Word Craft", product: "Caption pack for sellers", price: 2, spots: 3, digital: true, description: "100 captions for product posts." },
  { shop: "Kicks Care", product: "Sneaker cleaning kit", price: 6, spots: 1, digital: false, description: "Brush, foam and cloth." },
  { shop: "Voice Notes", product: "Podcast intro jingle", price: 4, spots: 2, digital: true, description: "Three short intros, royalty free." },
];

// Spread drops over the coming days: kickoff at least 2 hours away so people have time to buy.
const all = (await upcomingMatches(Date.now() + 2 * 3600_000, Date.now() + 7 * 86_400_000)).filter((m) => m.odds);
if (all.length === 0) { fail("no upcoming matches with odds"); process.exit(1); }
note(`${all.length} upcoming matches with odds`);
const byDay = new Map<string, Match[]>();
for (const m of all) {
  const d = m.kickoff.slice(0, 10);
  byDay.set(d, [...(byDay.get(d) ?? []), m]);
}
const picks: Match[] = [];
const days = [...byDay.values()];
for (let round = 0; picks.length < Math.min(COUNT, all.length); round++)
  for (const d of days) if (d[round] && picks.length < COUNT) picks.push(d[round]);
while (picks.length < COUNT) picks.push(picks[picks.length % all.length]); // fewer matches than drops: reuse


// A digital drop opens its content on the page after paying. If the practice site cannot seal it
// (DELIVERY_SECRET not set there), the drop still opens, just without that step.
let sealWorks = true;
async function sealText(text: string): Promise<string | undefined> {
  if (!sealWorks) return undefined;
  try {
    const r = await fetch(`${SITE}/api/seal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    const j = (await r.json()) as { sealed?: string; error?: string };
    if (r.ok && j.sealed) return j.sealed;
    fail(`instant delivery is off on the practice site (${j.error ?? r.status}); digital drops open without it`);
  } catch (e) {
    fail(`could not reach ${SITE}/api/seal: ${(e as Error).message}`);
  }
  sealWorks = false;
  return undefined;
}

let opened = 0;

for (let i = 0; i < COUNT; i++) {
  const s = SHOPS[i % SHOPS.length];
  const m = picks[i];
  const seller = privateKeyToAccount(keccak256(toBytes(`${SEED}:seller:${i}`)));
  const cap = parseUnits(String(s.spots * s.price), 6);
  console.log(`#${i + 1} ${s.shop} · ${s.product} $${s.price} · ${s.spots} free per side · ${m.title} ${m.kickoff} · seller ${seller.address}`);
  if (DRY) continue;
  try {
  // Top up gas. Selling needs no balance: the seller only pays gas to open the drop.
  const bal = (await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [seller.address] })) as bigint;
  if (bal < GAS_FLOAT / 2n) {
    const h = await funder!.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [seller.address, GAS_FLOAT - bal] });
    await pub.waitForTransactionReceipt({ hash: h });
  }

  const kickoff = Math.floor(Date.parse(m.kickoff) / 1000);
  const meta = JSON.stringify({
    slug: m.slug, league: m.league.name, teamA: m.teamA, teamB: m.teamB, kickoff: m.kickoff,
    shop: s.shop, product: s.product, priceUsd: s.price, description: s.description,
    profitUsd: s.digital ? s.price : Math.round(s.price * 0.6 * 100) / 100,
    delivery: s.digital ? await sealText(`Practice drop: in a real drop, ${s.product.toLowerCase()} would open here right after paying.`) : undefined,
    contact: s.digital ? undefined : "Practice drop: nothing is shipped.",
    practice: true,
    shape: "free", baseRates: [FULL, FULL], minBps: FULL, maxBps: FULL, effectiveBps: 0,
  });
  const wallet = createWalletClient({ account: seller, chain: arcTestnet, transport: http() });
  const hash = await wallet.writeContract({
    address: FACTORY, abi: tifoFactoryAbi, functionName: "createPromo",
    args: [keccak256(toBytes(m.slug)), BigInt(kickoff), BigInt(kickoff + m.league.durationMin * 60), cap, FULL, FULL, FULL, FULL, 0, DRAW, meta],
  });
  const rc = await pub.waitForTransactionReceipt({ hash });
  const log = rc.logs.find((l) => l.address.toLowerCase() === FACTORY.toLowerCase());
  const promo = log?.topics[1] ? `0x${log.topics[1].slice(26)}` : "(address not found)";
  note(`#${i + 1} ${s.product} on ${m.title}: ${SITE}/p/${promo}`);
  opened++;
  } catch (e) {
    fail(`#${i + 1} ${s.product} on ${m.title} failed: ${((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).split("\n")[0]}`);
  }
}
note(`opened ${opened} of ${COUNT} practice drops`);
if (opened === 0) process.exit(1);
