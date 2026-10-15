// End-to-end check of the money rules on Arc testnet, against a running app.
// A "free if your team wins" drop with two spots per side: the third buyer is refused the free offer and can
// still buy at full price; the other side keeps its spots; the seller opens an account with a weekly rule.
// Usage: TIFO_URL=http://localhost:3000 npx tsx --env-file=web/.env.development.local scripts/e2e-money.mts
import { createPublicClient, createWalletClient, erc20Abi as erc20, http, keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tifoAccountAbi, tifoFactoryAbi, tifoPromoAbi } from "../web/lib/abi.ts";
import { arcTestnet } from "../web/lib/chain.ts";
import { upcomingMatches } from "../web/lib/matches.ts";

const env = process.env as Record<string, string>;
const URL = env.TIFO_URL ?? "http://localhost:3000";
const FACTORY = (env.FACTORY ?? env.NEXT_PUBLIC_FACTORY) as Hex;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const ZERO = "0x0000000000000000000000000000000000000000";
const pub = createPublicClient({ chain: arcTestnet, transport: http() });
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const wallet = (k: string) => createWalletClient({ account: privateKeyToAccount((env[k] ?? env[`BACKUP_${k}`]) as Hex), chain: arcTestnet, transport: http() });
const seller = wallet("SELLER_PK");
const fans = [wallet("FAN1_PK"), wallet("FAN2_PK"), wallet("FAN3_PK")];
const sent = async (hash: Hex) => (await pub.waitForTransactionReceipt({ hash })).status === "success";

const PRICE = 250_000n; // $0.25, so the test wallets can afford it
const m = (await upcomingMatches(Date.now() + 2 * 3600_000, Date.now() + 10 * 86_400_000)).find((x) => x.odds);
if (!m) throw new Error("no priceable match in the next 10 days");
const kickoff = Math.floor(Date.parse(m.kickoff) / 1000);
const meta = {
  slug: m.slug, league: m.league.name, teamA: m.teamA, teamB: m.teamB, kickoff: m.kickoff,
  shop: "Tifo test seller", product: "Free spots check (testnet run)", priceUsd: 0.25, profitUsd: 0.25,
  shape: "free", baseRates: [10_000, 10_000], minBps: 10_000, maxBps: 10_000, effectiveBps: 0,
};
const createHash = await seller.writeContract({
  address: FACTORY, abi: tifoFactoryAbi, functionName: "createPromo",
  args: [keccak256(toBytes(m.slug)), BigInt(kickoff), BigInt(kickoff + 110 * 60), 2n * PRICE, 10_000, 10_000, 10_000, 10_000, 0, 500, 0, 0, PRICE, 0, JSON.stringify(meta)],
});
const rc = await pub.waitForTransactionReceipt({ hash: createHash });
const promo = `0x${rc.logs.find((l) => l.address.toLowerCase() === FACTORY.toLowerCase())!.topics[1]!.slice(26)}` as Hex;
console.log(`drop ${promo} on ${m.title} · ${URL}/p/${promo}`);

const buy = async (w: (typeof fans)[number], side: 0 | 1, minRate: number) => {
  await sent(await w.writeContract({ address: USDC, abi: erc20, functionName: "approve", args: [promo, PRICE] }));
  return w.writeContract({ address: promo, abi: tifoPromoAbi, functionName: "buy", args: [side, PRICE, keccak256(toBytes(`${w.account.address}:${Date.now()}`)), minRate] });
};
check("first buyer takes a free spot", await sent(await buy(fans[0], 0, 10_000)));
check("second buyer takes the last free spot", await sent(await buy(fans[1], 0, 10_000)));
const refused = await buy(fans[2], 0, 10_000).then(() => false, (e) => /OfferGone/.test(String(e)));
check("third buyer who was shown 'free' is refused, not charged for less", refused);
check("third buyer can still buy at full price", await sent(await buy(fans[2], 0, 0)));

const ref = keccak256(toBytes(`retry:${Date.now()}`));
await sent(await fans[0].writeContract({ address: USDC, abi: erc20, functionName: "approve", args: [promo, 2n * PRICE] }));
await sent(await fans[0].writeContract({ address: promo, abi: tifoPromoAbi, functionName: "buy", args: [0, PRICE, ref, 0] }));
const twice = await fans[0].writeContract({ address: promo, abi: tifoPromoAbi, functionName: "buy", args: [0, PRICE, ref, 0] }).then(() => false, (e) => /DuplicateOrder/.test(String(e)));
check("a retried checkout with the same order reference is not charged twice", twice);

const orders = await pub.readContract({ address: promo, abi: tifoPromoAbi, functionName: "getOrders", args: [0n, 10n] });
check("offers locked on chain are free, free, then none", orders.map((o) => o.rateBps).join(",") === "10000,10000,0,0", orders.map((o) => o.rateBps).join(","));
const [, , la, lb, reserve, cap] = await pub.readContract({ address: promo, abi: tifoPromoAbi, functionName: "book" });
check("the bill equals the budget and never passes it", la === cap && reserve === cap && lb === 0n, `owed ${la} of ${cap}`);
check("each buyer has a draw thank you set aside", (await pub.readContract({ address: promo, abi: tifoPromoAbi, functionName: "drawLiability" })) === (4n * PRICE * 500n) / 10_000n);

const html = await (await fetch(`${URL}/p/${promo}`)).text();
const text = html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
check("page shows the side that is full", /0 free spots left/.test(text));
check("page shows the other side still has 2 spots", /2 free spots left/.test(text));
check("page explains the draw thank you", /On a draw every buyer gets 5% back/.test(text));

let account = await pub.readContract({ address: FACTORY, abi: tifoFactoryAbi, functionName: "accountOf", args: [seller.account.address] });
if (account === ZERO) {
  await sent(await seller.writeContract({ address: FACTORY, abi: tifoFactoryAbi, functionName: "createAccount", args: [1000, 5_000_000n, 3_000_000n, "0x0000000000000000000000000000000000000000"] }));
  account = await pub.readContract({ address: FACTORY, abi: tifoFactoryAbi, functionName: "accountOf", args: [seller.account.address] });
}
const [owner, allowance, perDeal] = await Promise.all(
  (["owner", "allowance", "perDealCap"] as const).map((functionName) => pub.readContract({ address: account as Hex, abi: tifoAccountAbi, functionName })),
);
check("the seller has an account with their weekly rule on chain", owner === seller.account.address && allowance === 5_000_000n && perDeal === 3_000_000n, `account ${account}`);
const stolen = await fans[0].writeContract({ address: account as Hex, abi: tifoAccountAbi, functionName: "withdraw", args: [fans[0].account.address, 1n] }).then(() => true, () => false);
check("nobody but the owner can withdraw from the account", !stolen);
process.exit(failed ? 1 : 0);
