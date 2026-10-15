// Live check of the seller's rule on Arc testnet, on a throwaway factory where the test wallet plays the agent:
//  agent opens inside the rule; above the rule the contract refuses and the agent can only propose;
//  the seller approves the proposal and the drop opens through their account; a second answer is refused.
// The seller wallet is separate from the agent, as in production.
// Usage: FUNDER_PK=0x.. FACTORY=<throwaway factory with agent = funder> npx tsx scripts/e2e-proposal.mts
import { createPublicClient, createWalletClient, erc20Abi, http, keccak256, parseEventLogs, parseUnits, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tifoAccountAbi, tifoFactoryAbi } from "../web/lib/abi.ts";
import { arcTestnet } from "../web/lib/chain.ts";

const env = process.env as Record<string, string>;
const GH = !!env.GITHUB_ACTIONS;
const ok = (m: string) => console.log(GH ? `::notice::PASS ${m}` : `PASS ${m}`);
const bad = (m: string) => { console.log(GH ? `::error::FAIL ${m}` : `FAIL ${m}`); process.exitCode = 1; };
const check = (c: boolean, m: string) => (c ? ok(m) : bad(m));

const USDC = "0x3600000000000000000000000000000000000000" as const;
const FACTORY = env.FACTORY as Hex;
const pub = createPublicClient({ chain: arcTestnet, transport: http() });
const agent = privateKeyToAccount(env.FUNDER_PK as Hex);
const seller = privateKeyToAccount(keccak256(toBytes(`${env.FUNDER_PK}:e2e-proposal-seller`)));
const aw = createWalletClient({ account: agent, chain: arcTestnet, transport: http() });
const sw = createWalletClient({ account: seller, chain: arcTestnet, transport: http() });
const wait = (hash: Hex) => pub.waitForTransactionReceipt({ hash });

check(((await pub.readContract({ address: FACTORY, abi: tifoFactoryAbi, functionName: "agent" })) as string).toLowerCase() === agent.address.toLowerCase(), "throwaway factory's agent is the test wallet");
await wait(await aw.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [seller.address, parseUnits("0.5", 6)] })); // seller gas

// The seller's rule: $3 a week, at most $2 per drop.
let account = (await pub.readContract({ address: FACTORY, abi: tifoFactoryAbi, functionName: "accountOf", args: [seller.address] })) as Hex;
if (/^0x0+$/.test(account)) {
  const h = await sw.writeContract({ address: FACTORY, abi: tifoFactoryAbi, functionName: "createAccount", args: [0, parseUnits("3", 6), parseUnits("2", 6), "0x0000000000000000000000000000000000000000"] });
  await wait(h);
  account = (await pub.readContract({ address: FACTORY, abi: tifoFactoryAbi, functionName: "accountOf", args: [seller.address] })) as Hex;
  ok(`seller opened an account ${account} with a $3 weekly rule and $2 per drop (${h})`);
}

const now = Math.floor(Date.now() / 1000);
const terms = (cap: string, tag: string) => ({
  fixtureId: keccak256(toBytes(`e2e-proposal-${tag}-${now}`)),
  closesAt: BigInt(now + 7200),
  settleNotBefore: BigInt(now + 7200 + 6600),
  cap: parseUnits(cap, 6),
  minBps: 5000, maxBps: 5000, rateA: 5000, rateB: 5000, floorBps: 0, drawBps: 0, holdSecs: 0, minBuyers: 0, minAmount: parseUnits("1", 6), refNeeded: 0,
});
const meta = (tag: string) => JSON.stringify({ slug: `e2e-proposal-${tag}`, league: "Check", teamA: "Home", teamB: "Away", kickoff: new Date((now + 7200) * 1000).toISOString(), shop: "Tifo check", product: `Rule check ${tag} (not for sale)`, priceUsd: 1, baseRates: [5000, 5000], minBps: 5000, maxBps: 5000, effectiveBps: 5000 });

// 1. Inside the rule: the agent opens it by itself.
const inside = await aw.writeContract({ address: account, abi: tifoAccountAbi, functionName: "openDeal", args: [terms("1", "inside"), meta("inside"), "inside the rule"] });
await wait(inside);
ok(`agent opened a $1 drop inside the rule (${inside})`);

// 2. Above the per-drop limit: the contract refuses the agent.
try {
  await pub.simulateContract({ account: agent, address: account, abi: tifoAccountAbi, functionName: "openDeal", args: [terms("2.5", "over"), meta("over"), "over the rule"] });
  bad("agent was able to open a $2.50 drop over the $2 limit");
} catch (e) {
  check(/OverLimit/.test(String((e as Error).message)), "contract refused the agent's $2.50 drop (OverLimit)");
}

// 3. So it proposes instead, and the seller approves.
const prop = await aw.writeContract({ address: account, abi: tifoAccountAbi, functionName: "propose", args: [terms("2.5", "over"), meta("over"), "a bigger match is worth $2.50"] });
const prc = await wait(prop);
const id = parseEventLogs({ abi: tifoAccountAbi, logs: prc.logs, eventName: "Proposed" })[0].args.id;
ok(`agent left proposal #${id} for $2.50 (${prop})`);
try {
  await pub.simulateContract({ account: agent, address: account, abi: tifoAccountAbi, functionName: "decide", args: [id, true] });
  bad("the agent could approve its own proposal");
} catch {
  ok("the agent cannot approve its own proposal");
}
const dec = await sw.writeContract({ address: account, abi: tifoAccountAbi, functionName: "decide", args: [id, true] });
const drc = await wait(dec);
const opened = parseEventLogs({ abi: tifoAccountAbi, logs: drc.logs, eventName: "DealOpened" })[0];
check(!!opened && opened.args.cap === parseUnits("2.5", 6), `seller approved and the $2.50 drop opened at ${opened?.args.promo} (${dec})`);
try {
  await pub.simulateContract({ account: seller, address: account, abi: tifoAccountAbi, functionName: "decide", args: [id, true] });
  bad("a proposal could be answered twice");
} catch (e) {
  check(/AlreadyDecided/.test(String((e as Error).message)), "a second answer is refused (AlreadyDecided)");
}
