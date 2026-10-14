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
const COUNT = Number(env.COUNT ?? 10);
// AFTER (unix seconds): only use matches that kick off later than this, so new drops list above older ones.
const AFTER = Number(env.AFTER ?? 0);
const FACTORY = need("FACTORY") as Hex;
const SEED = need("PRACTICE_SEED");
const SITE = need("PRACTICE_URL").replace(/\/$/, "");
const USDC = "0x3600000000000000000000000000000000000000" as const;
const GAS_FLOAT = parseUnits("0.2", 6); // test USDC each seller keeps for gas
const FULL = 10_000, DRAW = 500;

const pub = createPublicClient({ chain: arcTestnet, transport: http() });
const funder = DRY ? null : createWalletClient({ account: privateKeyToAccount(need("FUNDER_PK") as Hex), chain: arcTestnet, transport: http() });

// Invented practice shops: plain everyday items a small seller would list. Photos are free to use, from Unsplash.
// Every buyer gets the same share back if their team wins (25%, 50% or all of it), and the stock caps the cost.
const U = (id: string) => `https://images.unsplash.com/${id}?w=900&h=900&fit=crop&q=80`;
const SHOPS: { shop: string; product: string; image: string; price: number; stock: number; tier: number; description: string }[] = [
  { shop: "Plain Goods", product: "Plain white tee", image: U("photo-1778671394516-8270eac13c42"), price: 12, stock: 10, tier: 5_000, description: "Heavy cotton, cut to sit square." },
  { shop: "Offday", product: "Heavy black hoodie", image: U("photo-1581655353466-d5ad6765dd37"), price: 20, stock: 10, tier: 2_500, description: "Brushed fleece with a double hood." },
  { shop: "Kora Leather", product: "Tan leather tote", image: U("photo-1624687943971-e86af76d57de"), price: 18, stock: 10, tier: 2_500, description: "Full grain leather, stitched by hand." },
  { shop: "Minute", product: "Black dial watch", image: U("photo-1565530557873-14ab8a68a85b"), price: 20, stock: 10, tier: 2_500, description: "Slim case on a brown leather strap." },
  { shop: "Lowtop", product: "White everyday sneakers", image: U("photo-1625860191460-10a66c7384fb"), price: 20, stock: 10, tier: 2_500, description: "Clean leather, easy to wipe down." },
  { shop: "Sixpanel", product: "Plain white cap", image: U("photo-1691256676359-20e5c6d4bc92"), price: 8, stock: 10, tier: 10_000, description: "Structured crown, strap at the back." },
  { shop: "Shade Club", product: "Classic sunglasses", image: U("photo-1588768897961-332c50c55d18"), price: 10, stock: 10, tier: 5_000, description: "Three frames, all with dark lenses." },
  { shop: "Daypack Co", product: "Navy day backpack", image: U("photo-1553062407-98eeb64c6a62"), price: 16, stock: 10, tier: 2_500, description: "Fits a laptop and a change of clothes." },
  { shop: "Gilded", product: "Gold bangle", image: U("photo-1655707063092-5c4509de41b8"), price: 14, stock: 10, tier: 5_000, description: "Plated brass with a hinge clasp." },
  { shop: "No. 9", product: "Clear bottle perfume", image: U("photo-1594125311687-3b1b3eafa9f4"), price: 15, stock: 10, tier: 5_000, description: "Warm and woody, lasts the day." },
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
if (AFTER > 0) {
  // The latest kickoffs, best known leagues first. Several drops may share a match.
  const BIG = ["Champions League", "Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "Europa League"];
  const late = all
    .filter((m) => Date.parse(m.kickoff) / 1000 > AFTER)
    .sort((x, y) => Number(BIG.includes(y.league.name)) - Number(BIG.includes(x.league.name)) || Date.parse(y.kickoff) - Date.parse(x.kickoff));
  if (late.length === 0) { fail(`no match with odds kicks off after ${new Date(AFTER * 1000).toISOString()}`); process.exit(1); }
  for (let i = 0; i < COUNT; i++) picks.push(late[i % Math.min(late.length, 5)]);
} else {
  const days = [...byDay.values()];
  for (let round = 0; picks.length < Math.min(COUNT, all.length); round++)
    for (const d of days) if (d[round] && picks.length < COUNT) picks.push(d[round]);
  while (picks.length < COUNT) picks.push(picks[picks.length % all.length]); // fewer matches than drops: reuse
}


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
  const cap = parseUnits(((s.stock * s.price * s.tier) / FULL).toFixed(2), 6);
  console.log(`#${i + 1} ${s.shop} · ${s.product} $${s.price} · ${s.tier / 100}% back · ${s.stock} in stock · ${m.title} ${m.kickoff} · seller ${seller.address}`);
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
    shop: s.shop, product: s.product, priceUsd: s.price, image: s.image, description: s.description,
    profitUsd: Math.round(s.price * 0.6 * 100) / 100,
    contact: "Practice drop: nothing is shipped.",
    practice: true,
    shape: s.tier >= FULL ? "free" : "back", backBps: s.tier, stock: s.stock,
    baseRates: [s.tier, s.tier], minBps: s.tier, maxBps: s.tier, effectiveBps: s.tier >= FULL ? 0 : s.tier,
  });
  const wallet = createWalletClient({ account: seller, chain: arcTestnet, transport: http() });
  const hash = await wallet.writeContract({
    address: FACTORY, abi: tifoFactoryAbi, functionName: "createPromo",
    // Shipped items hold the seller's share until delivery; on a practice drop nothing ships, so it returns to the buyer.
    args: [keccak256(toBytes(m.slug)), BigInt(kickoff), BigInt(kickoff + m.league.durationMin * 60), cap, s.tier, s.tier, s.tier, s.tier, 0, DRAW, 7 * 86_400, meta],
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
