(globalThis as any).window = { location: { hostname: "tifo.vercel.app", origin: "https://tifo.vercel.app", href: "https://tifo.vercel.app/" } };
// Spike S6: does Circle's paymaster sponsor gas for a Circle smart account on Arc testnet?
// Uses a throwaway local key as the account owner (passkeys need a browser; the gas question doesn't).
import { createPublicClient, encodeFunctionData, erc20Abi, type Hex } from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { toCircleSmartAccount, toModularTransport } from "@circle-fin/modular-wallets-core";
import { arcTestnet } from "../web/lib/chain.ts";

const clientKey = process.env.NEXT_PUBLIC_CIRCLE_CLIENT_KEY!;
const url = "https://modular-sdk.circle.com/v1/rpc/w3s/buidl/arcTestnet";
const transport = toModularTransport(url, clientKey);
const client = createPublicClient({ chain: arcTestnet, transport });
const bundler = createBundlerClient({ chain: arcTestnet, transport });
const owner = privateKeyToAccount(generatePrivateKey());
const account = await toCircleSmartAccount({ client, owner: owner as never });
console.log("smart account", account.address);
const USDC = "0x3600000000000000000000000000000000000000" as Hex;
// A zero-value USDC transfer to self: proves a sponsored user operation lands with an empty wallet.
const hash = await bundler.sendUserOperation({
  account,
  calls: [{ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [account.address, 0n] }) }],
  paymaster: true,
});
console.log("userOp", hash);
const { receipt } = await bundler.waitForUserOperationReceipt({ hash });
console.log("tx", receipt.transactionHash, "status", receipt.status);
