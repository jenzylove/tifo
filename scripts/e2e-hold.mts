// End to end on Arc testnet: a physical drop holds the seller's share until delivery.
//  A) buy -> seller marks sent -> buyer confirms -> seller paid
//  B) buy -> never marked sent -> after the hold, anyone returns it to the buyer
// The drops are labelled "check, not for sale" so they never show on the boards.
// Usage: FUNDER_PK=0x.. FACTORY=0x.. npx tsx scripts/e2e-hold.mts
import { createPublicClient, createWalletClient, erc20Abi, http, keccak256, parseUnits, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tifoFactoryAbi, tifoPromoAbi } from "../web/lib/abi.ts";
import { arcTestnet } from "../web/lib/chain.ts";

const env = process.env as Record<string, string>;
const GH = !!env.GITHUB_ACTIONS;
const ok = (m: string) => console.log(GH ? `::notice::PASS ${m}` : `PASS ${m}`);
const bad = (m: string) => { console.log(GH ? `::error::FAIL ${m}` : `FAIL ${m}`); process.exitCode = 1; };
const check = (cond: boolean, m: string) => (cond ? ok(m) : bad(m));

const USDC = "0x3600000000000000000000000000000000000000" as const;
const FACTORY = env.FACTORY as Hex;
const pub = createPublicClient({ chain: arcTestnet, transport: http() });
const seller = privateKeyToAccount(env.FUNDER_PK as Hex);
const buyer = privateKeyToAccount(keccak256(toBytes(`${env.FUNDER_PK}:e2e-hold-buyer`)));
const sw = createWalletClient({ account: seller, chain: arcTestnet, transport: http() });
const bw = createWalletClient({ account: buyer, chain: arcTestnet, transport: http() });
const bal = async (a: Hex) => (await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] })) as bigint;
const wait = (hash: Hex) => pub.waitForTransactionReceipt({ hash });
const PRICE = parseUnits("1", 6);

// fund the buyer for two orders plus gas
if ((await bal(buyer.address)) < parseUnits("2.5", 6)) await wait(await sw.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [buyer.address, parseUnits("3", 6)] }));

async function openDrop(holdSecs: number, label: string): Promise<Hex> {
  const now = Math.floor(Date.now() / 1000);
  const meta = JSON.stringify({ slug: `e2e-hold-${label}-${now}`, league: "Check", teamA: "Home", teamB: "Away", kickoff: new Date((now + 3600) * 1000).toISOString(), shop: "Tifo check", product: `Delivery hold check ${label} (not for sale)`, priceUsd: 1, contact: "check", shape: "back", backBps: 5000, baseRates: [5000, 5000], minBps: 5000, maxBps: 5000, effectiveBps: 5000 });
  const hash = await sw.writeContract({ address: FACTORY, abi: tifoFactoryAbi, functionName: "createPromo", args: [keccak256(toBytes(meta)), BigInt(now + 3600), BigInt(now + 3600 + 6600), parseUnits("1", 6), 5000, 5000, 5000, 5000, 0, 0, holdSecs, meta] });
  const rc = await wait(hash);
  const log = rc.logs.find((l) => l.address.toLowerCase() === FACTORY.toLowerCase());
  const promo = `0x${log!.topics[1]!.slice(26)}` as Hex;
  console.log(`${label}: drop ${promo} tx ${hash}`);
  return promo;
}

async function buy(promo: Hex, ref: string) {
  await wait(await bw.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [promo, PRICE] }));
  const h = await bw.writeContract({ address: promo, abi: tifoPromoAbi, functionName: "buy", args: [0, PRICE, keccak256(toBytes(ref)), 0] });
  await wait(h);
  return h;
}

const ship = async (promo: Hex) => (await pub.readContract({ address: promo, abi: tifoPromoAbi, functionName: "getShipments", args: [0n, 1n] }))[0];

// A) delivered
{
  const promo = await openDrop(7 * 86_400, "A");
  const s0 = await bal(seller.address);
  const buyTx = await buy(promo, `A-${Date.now()}`);
  const held = (await ship(promo)).held;
  check(held === parseUnits("0.5", 6), `A: seller's share ($0.50) held in the drop after the sale (${buyTx})`);
  check((await bal(seller.address)) === s0, "A: seller not paid at sale");
  const sent = await sw.writeContract({ address: promo, abi: tifoPromoAbi, functionName: "markSent", args: [0n, "Chowdeck CHW-TEST-1"] });
  await wait(sent);
  const s1 = await ship(promo);
  check(s1.state === 2 && s1.tracking === "Chowdeck CHW-TEST-1", `A: seller marked it sent with tracking (${sent})`);
  try {
    await pub.simulateContract({ account: seller, address: promo, abi: tifoPromoAbi, functionName: "confirmReceived", args: [0n] });
    bad("A: seller was able to confirm their own delivery");
  } catch {
    ok("A: seller cannot confirm their own delivery");
  }
  const conf = await bw.writeContract({ address: promo, abi: tifoPromoAbi, functionName: "confirmReceived", args: [0n] });
  await wait(conf);
  check((await bal(seller.address)) - s0 === parseUnits("0.5", 6) - 0n || (await bal(seller.address)) > s0, `A: buyer confirmed and the seller was paid (${conf})`);
  check((await ship(promo)).state === 4, "A: order shows Released");
}

// B) never sent: a 60 second hold so the return can be shown now
{
  const promo = await openDrop(60, "B");
  const b0 = await bal(buyer.address);
  await buy(promo, `B-${Date.now()}`);
  try {
    await pub.simulateContract({ account: seller, address: promo, abi: tifoPromoAbi, functionName: "refundUnsent", args: [0n] });
    bad("B: refund allowed before the hold ended");
  } catch {
    ok("B: no refund before the hold ends");
  }
  await new Promise((r) => setTimeout(r, 70_000));
  const back = await sw.writeContract({ address: promo, abi: tifoPromoAbi, functionName: "refundUnsent", args: [0n] });
  await wait(back);
  const b1 = await bal(buyer.address);
  check(b1 === b0 - PRICE + parseUnits("0.5", 6), `B: never sent, the held $0.50 went back to the buyer (${back})`);
  check((await ship(promo)).state === 5, "B: order shows Refunded");
}
