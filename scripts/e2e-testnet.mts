// End-to-end run against the live app on Arc testnet, with a real upcoming match.
// 1) The seller opens a promo from their own wallet (factory.createPromo, seller = msg.sender).
// 2) Three fans sign USDC permits; the live /api/relay submits them gaslessly.
// 3) The agent rebalances after sales (on chain, with reasons).
// Settlement then runs from the scheduler after full time.
// Usage: TIFO_URL=https://tifo.vercel.app SLUG=mls-sea-skc-2026-10-01 npx tsx scripts/e2e-testnet.mts
import { createPublicClient, createWalletClient, http, keccak256, parseSignature, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { initialRates } from "../packages/core/src/index.ts";
import { tifoFactoryAbi, erc20Abi } from "../web/lib/abi.ts";
import { arcTestnet } from "../web/lib/chain.ts";
import { matchBySlug } from "../web/lib/matches.ts";

const env = process.env as Record<string, string>;
const URL = env.TIFO_URL ?? "https://tifo.vercel.app";
const FACTORY = env.FACTORY as Hex;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const pub = createPublicClient({ chain: arcTestnet, transport: http() });

const m = await matchBySlug(env.SLUG);
if (!m?.odds) throw new Error(`match not priceable: ${env.SLUG} ${m?.oddsProblem}`);
const kickoff = Math.floor(Date.parse(m.kickoff) / 1000);
const [ra, rb] = initialRates(m.odds, 1000, 500, 6000).map(Number) as [number, number];
console.log(`${m.title} · kickoff ${m.kickoff} · odds ${m.odds.pA.toFixed(2)}/${m.odds.pDraw.toFixed(2)}/${m.odds.pB.toFixed(2)} → offers ${ra / 100}% / ${rb / 100}%`);

const seller = createWalletClient({ account: privateKeyToAccount(env.SELLER_PK as Hex), chain: arcTestnet, transport: http() });
const meta = {
  slug: m.slug, league: m.league.name, teamA: m.teamA, teamB: m.teamB, kickoff: m.kickoff,
  shop: env.SHOP ?? "Tifo test shop", product: env.PRODUCT ?? "Matchday scarf (testnet run)", priceUsd: Number(env.PRICE ?? 2), image: env.IMAGE || undefined,
  description: env.DESC || undefined,
  baseRates: [ra, rb], minBps: 500, maxBps: 6000, effectiveBps: 1000,
};
const createHash = await seller.writeContract({
  address: FACTORY, abi: tifoFactoryAbi, functionName: "createPromo",
  args: [keccak256(toBytes(m.slug)), BigInt(kickoff), BigInt(kickoff + 110 * 60), 3_000_000n, 500, 6000, ra, rb, 0, 500, JSON.stringify(meta)],
});
const rc = await pub.waitForTransactionReceipt({ hash: createHash });
const promo = `0x${rc.logs.find((l) => l.address.toLowerCase() === FACTORY.toLowerCase())!.topics[1]!.slice(26)}` as Hex;
console.log("promo", promo, "created", createHash);

const unit = BigInt(Math.round(Number(env.PRICE ?? 2) * 1e6));
const fans: [string, 0 | 1, bigint][] = env.FANS === "none" ? [] : (env.FANS ?? "FAN1_PK:0,FAN2_PK:0,FAN3_PK:1").split(",").map((f) => { const [k, s] = f.split(":"); return [k, Number(s) as 0 | 1, unit]; });
for (const [key, side, amount] of fans) {
  const acct = privateKeyToAccount(env[key] as Hex);
  const nonce = (await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "nonces", args: [acct.address] })) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const sig = await acct.signTypedData({
    domain: { name: "USDC", version: "2", chainId: arcTestnet.id, verifyingContract: USDC },
    types: { Permit: [
      { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] },
    primaryType: "Permit",
    message: { owner: acct.address, spender: promo, value: amount, nonce, deadline },
  });
  const { r, s, v, yParity } = parseSignature(sig);
  const res = await fetch(`${URL}/api/relay`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ promo, buyer: acct.address, side, amount: amount.toString(), orderRef: keccak256(toBytes(`${key}:${Date.now()}`)), deadline: deadline.toString(), v: Number(v ?? BigInt(27 + (yParity ?? 0))), r, s }),
  });
  const j = await res.json();
  console.log(key, side === 0 ? m.teamA : m.teamB, res.status, JSON.stringify(j));
}
console.log(`page: ${URL}/p/${promo}`);
