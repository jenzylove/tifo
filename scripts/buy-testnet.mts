// One gasless buy through the live relayer. Usage: PROMO=0x.. KEY=FAN1_PK SIDE=0 AMOUNT=1000000 npx tsx scripts/buy-testnet.mts
import { createPublicClient, http, keccak256, parseSignature, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "../web/lib/abi.ts";
import { arcTestnet } from "../web/lib/chain.ts";
const env = process.env as Record<string, string>;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const pub = createPublicClient({ chain: arcTestnet, transport: http() });
const acct = privateKeyToAccount(env[env.KEY] as Hex);
const promo = env.PROMO as Hex, side = Number(env.SIDE), amount = BigInt(env.AMOUNT);
const nonce = (await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "nonces", args: [acct.address] })) as bigint;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
const sig = await acct.signTypedData({
  domain: { name: "USDC", version: "2", chainId: arcTestnet.id, verifyingContract: USDC },
  types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  primaryType: "Permit", message: { owner: acct.address, spender: promo, value: amount, nonce, deadline },
});
const { r, s, v, yParity } = parseSignature(sig);
const res = await fetch(`${env.TIFO_URL ?? "https://tifo.vercel.app"}/api/relay`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ promo, buyer: acct.address, side, amount: amount.toString(), orderRef: keccak256(toBytes(`${acct.address}:${Date.now()}`)), deadline: deadline.toString(), v: Number(v ?? BigInt(27 + (yParity ?? 0))), r, s }) });
console.log(res.status, JSON.stringify(await res.json()));
