// End-to-end check of digital delivery on Arc testnet, against a running app.
// 1) Seal a delivery note through /api/seal and open a drop that carries it.
// 2) A fan buys with an order reference that is the hash of a secret only they hold.
// 3) /api/unlock opens the note for that secret and refuses a wrong secret or an unpaid order.
// Usage: TIFO_URL=http://localhost:3000 npx tsx --env-file=web/.env.development.local scripts/e2e-delivery.mts
import { createPublicClient, createWalletClient, erc20Abi as erc20, http, keccak256, toBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { initialRates } from "../packages/core/src/index.ts";
import { tifoFactoryAbi, tifoPromoAbi } from "../web/lib/abi.ts";
import { arcTestnet } from "../web/lib/chain.ts";
import { upcomingMatches } from "../web/lib/matches.ts";

const env = process.env as Record<string, string>;
const URL = env.TIFO_URL ?? "http://localhost:3000";
const FACTORY = (env.FACTORY ?? env.NEXT_PUBLIC_FACTORY) as Hex;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const pub = createPublicClient({ chain: arcTestnet, transport: http() });
const post = (path: string, body: unknown) => fetch(`${URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const sellerAcct = privateKeyToAccount((env.SELLER_PK ?? env.BACKUP_SELLER_PK) as Hex);
const fanAcct = privateKeyToAccount((env.FAN1_PK ?? env.BACKUP_FAN1_PK) as Hex);
const seller = createWalletClient({ account: sellerAcct, chain: arcTestnet, transport: http() });
const fan = createWalletClient({ account: fanAcct, chain: arcTestnet, transport: http() });
const bal = (a: Hex) => pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] });
console.log(`seller ${sellerAcct.address} $${Number(await bal(sellerAcct.address)) / 1e6} · fan ${fanAcct.address} $${Number(await bal(fanAcct.address)) / 1e6}`);

const note = `https://example.com/download/tifo-test-${Date.now()}`;
const sealRes = await post("/api/seal", { text: note, owner: sellerAcct.address });
const { sealed } = await sealRes.json();
check("seal returns a sealed note that hides the link", sealRes.ok && typeof sealed === "string" && !sealed.includes("example.com"));

const m = (await upcomingMatches(Date.now() + 2 * 3600_000, Date.now() + 10 * 86_400_000)).find((x) => x.odds);
if (!m?.odds) throw new Error("no priceable match in the next 10 days");
const kickoff = Math.floor(Date.parse(m.kickoff) / 1000);
const [ra, rb] = initialRates(m.odds, 1000, 500, 6000).map(Number) as [number, number];
const meta = {
  slug: m.slug, league: m.league.name, teamA: m.teamA, teamB: m.teamB, kickoff: m.kickoff,
  shop: "Tifo test seller", product: "Budget template (testnet run)", priceUsd: 1, profitUsd: 1, delivery: sealed,
  baseRates: [ra, rb], minBps: 500, maxBps: 6000, effectiveBps: 1000,
};
const createHash = await seller.writeContract({
  address: FACTORY, abi: tifoFactoryAbi, functionName: "createPromo",
  args: [keccak256(toBytes(m.slug)), BigInt(kickoff), BigInt(kickoff + 110 * 60), 2_000_000n, 500, 6000, ra, rb, 0, 500, 0, 0, 1_000_000n, 0, JSON.stringify(meta)],
});
const rc = await pub.waitForTransactionReceipt({ hash: createHash });
const promo = `0x${rc.logs.find((l) => l.address.toLowerCase() === FACTORY.toLowerCase())!.topics[1]!.slice(26)}` as Hex;
console.log(`drop ${promo} on ${m.title} · offers ${ra / 100}% / ${rb / 100}% · ${URL}/p/${promo}`);

const page = await fetch(`${URL}/p/${promo}`);
const html = await page.text();
check("drop page renders the product", page.ok && html.includes("Budget template"));
check("drop page never contains the link", !html.includes("example.com"));

const secret = toHex(crypto.getRandomValues(new Uint8Array(32)));
const amount = 1_000_000n;
await pub.waitForTransactionReceipt({ hash: await fan.writeContract({ address: USDC, abi: erc20, functionName: "approve", args: [promo, amount] }) });
const buyHash = await fan.writeContract({ address: promo, abi: tifoPromoAbi, functionName: "buy", args: [0, amount, keccak256(secret), ra] });
await pub.waitForTransactionReceipt({ hash: buyHash });
console.log("bought", buyHash);

const good = await post("/api/unlock", { promo, hash: buyHash, secret });
check("the buyer opens their purchase", good.ok && (await good.json()).delivery === note);
const wrong = await post("/api/unlock", { promo, hash: buyHash, secret: toHex(crypto.getRandomValues(new Uint8Array(32))) });
check("a wrong secret is refused", wrong.status === 403);
const unpaid = await post("/api/unlock", { promo, hash: createHash, secret });
check("a transaction that is not a purchase is refused", unpaid.status === 403);
const never = await post("/api/unlock", { promo, hash: keccak256(toBytes("nothing")), secret });
check("an unknown transaction is refused", never.status === 409);

for (const path of ["/", "/drops", "/manage", "/proof"]) check(`${path} loads`, (await fetch(`${URL}${path}`)).ok);
process.exit(failed ? 1 : 0);
